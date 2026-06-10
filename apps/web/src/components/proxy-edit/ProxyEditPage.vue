<script setup lang="ts">
// URL parsing runs on every keystroke via parseProxyUri. Import from the
// package's /url, /proxy-config, and /constants subpaths rather than the
// barrel — the barrel pulls in runProxiedRequest and the userspace TLS
// stack, which transitively depend on Node's crypto and inflate the
// dashboard bundle. The parser itself is pure (no SocketDial, no TLS),
// so the subpath gives live feedback without dial-time code. The gateway
// re-parses on POST/PATCH, so this client check is not load-bearing for
// security.
//
// The page hosts a bidirectional sync between the URL field and a
// `ProxyConfigForm`: typing in the URL repopulates the form, editing the
// form regenerates the URL via formatProxyUri. A per-tick `lastSource`
// guard prevents the two watchers from ping-ponging — whichever side just
// pushed an update marks itself as the source and the other side skips
// re-deriving.

import { useNow, useTimeoutFn } from '@vueuse/core';
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { defaultsFor } from './proxy-form-defaults.ts';
import ProxyConfigForm from './ProxyConfigForm.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { BackoffRow, ProxyConflictBody, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { formatCountdown, formatRelativeAgo } from '../../utils/format-countdown.ts';
import { DEFAULT_DIAL_DEADLINE_MS } from '@floway-dev/proxy/constants';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri, parseProxyUri } from '@floway-dev/proxy/url';
import { Button, Input, Spinner } from '@floway-dev/ui';

const props = defineProps<{
  mode: 'create' | 'edit';
  record: ProxyRecord | null;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();
const router = useRouter();
const proxiesStore = useProxiesStore();
const upstreamsStore = useUpstreamsStore();

const name = ref(props.record?.name ?? '');
const url = ref(props.record?.url ?? '');
const lastEgressIp = computed(() => props.record?.last_egress_ip ?? null);
const lastTestedAt = computed(() => props.record?.last_tested_at ?? null);

const tryParse = (raw: string): { ok: true; config: ProxyConfig } | { ok: false; error: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return { ok: true, config: parseProxyUri(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Canonical form-side state. In edit mode, seeded by parsing the row's URL;
// in create mode, seeded with an empty HTTP default so the form panel
// renders before the operator has typed a URL — the panel's own kind
// selector then lets them switch protocols and start building the URL
// field via the bidirectional sync. When the URL becomes unparseable
// mid-edit we keep the last good config so the form does not reset under
// the operator and dim it via the urlError prop instead.
const initialParse = tryParse(url.value);
const initialConfig: ProxyConfig | null = initialParse?.ok
  ? initialParse.config
  : (props.mode === 'create' ? defaultsFor('http', { host: '', port: 0, name: '' }) : null);
const config = ref<ProxyConfig | null>(initialConfig);
const urlError = ref<string | null>(initialParse && !initialParse.ok ? initialParse.error : null);

// Single-tick guard: whichever side just pushed a change tags itself as
// the source so the other side's watcher can skip re-deriving and avoid a
// feedback loop. Cleared on the next tick.
let lastSource: 'url' | 'form' | null = null;

watch(url, next => {
  if (lastSource === 'form') { lastSource = null; return; }
  const parsed = tryParse(next);
  if (parsed === null) {
    lastSource = 'url';
    config.value = null;
    urlError.value = null;
    void nextTick(() => { if (lastSource === 'url') lastSource = null; });
    return;
  }
  if (parsed.ok) {
    lastSource = 'url';
    config.value = parsed.config;
    urlError.value = null;
    void nextTick(() => { if (lastSource === 'url') lastSource = null; });
  } else {
    urlError.value = parsed.error;
  }
});

watch(config, next => {
  if (lastSource === 'url') { lastSource = null; return; }
  lastSource = 'form';
  url.value = formatProxyUri(next!);
  urlError.value = null;
  void nextTick(() => { if (lastSource === 'form') lastSource = null; });
});

// Per-proxy dial-stage deadline. Stored as a string to make "empty" the
// canonical "use default" signal; coerced to a number on save. The
// initial seed runs once: the parent re-mounts the component (via
// :key="record.id") whenever the row changes, so a parent-store reload
// against the SAME id must not clobber whatever the operator is typing.
const DEFAULT_DIAL_TIMEOUT_SECONDS = Math.floor(DEFAULT_DIAL_DEADLINE_MS / 1000);
const initialDialTimeout = props.record?.dial_timeout_seconds;
const dialTimeoutInput = ref<string>(initialDialTimeout == null ? '' : String(initialDialTimeout));

const dialTimeoutParsed = computed<{ value: number | null } | { error: string }>(() => {
  const raw = dialTimeoutInput.value.trim();
  if (raw === '') return { value: null };
  if (!/^[1-9][0-9]*$/.test(raw)) return { error: 'Whole seconds, > 0' };
  const n = Number(raw);
  if (n > 600) return { error: 'Must be at most 600 seconds' };
  return { value: n };
});

// Match the URL example to the current form kind so the placeholder
// reflects what the bidirectional sync would emit for an empty form.
const urlPlaceholder = computed(() => {
  switch (config.value?.kind) {
  case 'http': return config.value.tls ? 'https://user:pass@host:443' : 'http://user:pass@host:8080';
  case 'socks5': return 'socks5://user:pass@host:1080';
  case 'ss': return 'ss://method:password@host:port';
  case 'ss2022': return 'ss://2022-blake3-aes-128-gcm:base64-key@host:port';
  case 'trojan': return 'trojan://password@host:443?sni=server.example.com';
  case 'vless-tcp': return 'vless://uuid@host:443?type=tcp&security=tls&sni=server.example.com';
  case 'vless-ws': return 'vless://uuid@host:443?type=ws&security=tls&sni=server.example.com&path=/ws';
  case 'reality': return 'vless://uuid@host:443?type=tcp&security=reality&pbk=...&sni=...&sid=...';
  default: return 'vless://uuid@host:443?...';
  }
});

const saving = ref(false);
const saveError = ref<string | null>(null);

const testing = ref(false);
const testCoolingDown = ref(false);
const testError = ref<string | null>(null);

const deleting = ref(false);
const deleteError = ref<{ message: string; referencingUpstreamIds: string[] } | null>(null);

const backoffsForProxy = computed<BackoffRow[]>(() => {
  if (!props.record) return [];
  return proxiesStore.backoffsByProxyId.value.get(props.record.id) ?? [];
});

const upstreamNames = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const u of upstreamsStore.upstreams.value ?? []) map.set(u.id, u.name);
  return map;
});

// 1s tick to drive the backoff "in Xm Ys" countdown without a parent reload.
const now = useNow({ interval: 1000 });

const activeBackoffs = computed(() => {
  const nowSec = Math.floor(now.value.getTime() / 1000);
  // `>=` keeps the row visible during its expiry second so the countdown's
  // last tick renders the 'expiring' label. A strict `>` would hide the row
  // before the delta could go ≤ 0, leaving the edge label unreachable.
  return backoffsForProxy.value
    .filter(b => b.expires_at >= nowSec)
    .sort((a, b) => a.expires_at - b.expires_at);
});

const lastTestedAgo = computed<string | null>(() => {
  if (lastTestedAt.value === null) return null;
  return formatRelativeAgo(now.value.getTime() - lastTestedAt.value * 1000);
});

const { start: startTestCooldown } = useTimeoutFn(
  () => { testCoolingDown.value = false; },
  3000,
  // The cooldown blocks both Test (anti double-spend on the anchor) and
  // Save: a save during the post-test window would race the parent's
  // store reload that's bringing in the just-persisted egress_ip /
  // last_tested_at, and a save before that lands could overwrite the
  // freshly-tested URL with a stale display.
  { immediate: false },
);

const save = async () => {
  saveError.value = null;
  const trimmedName = name.value.trim();
  const trimmedUrl = url.value.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }
  if (!trimmedUrl) { saveError.value = 'URL is required'; return; }
  // Re-parse the URL we are about to submit so structural URL-grammar
  // failures (an empty REALITY pbk, a non-hex REALITY shortId) surface as
  // the same `Invalid proxy URI` save error as text typed directly into
  // the URL field. The config→url watcher zeroes urlError on every form
  // edit, so without this check a config edited via the form panel into a
  // structurally invalid state would skip past the URL-field guard.
  // Per-field semantic checks (empty Trojan/SS password, port=0) round-
  // trip cleanly through the formatter and rely on the server-side
  // config-stage validator to reject.
  const parsed = tryParse(trimmedUrl);
  if (parsed && !parsed.ok) {
    saveError.value = `Invalid proxy URI: ${parsed.error}`;
    return;
  }
  if ('error' in dialTimeoutParsed.value) {
    saveError.value = `Dial timeout: ${dialTimeoutParsed.value.error}`;
    return;
  }
  const dialTimeoutSeconds = dialTimeoutParsed.value.value;

  saving.value = true;
  try {
    if (props.mode === 'create') {
      const { data, error } = await callApi<ProxyRecord>(
        () => api.api.proxies.$post({ json: { name: trimmedName, url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds } }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved');
      await router.push(`/dashboard/proxies/${data.id}`);
    } else if (props.record) {
      const { error } = await callApi(
        () => api.api.proxies[':id'].$patch({
          param: { id: props.record!.id },
          json: { name: trimmedName, url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds },
        }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved');
      await router.push('/dashboard/settings');
    }
  } finally {
    saving.value = false;
  }
};

const cancel = async () => {
  await router.push('/dashboard/settings');
};

const test = async () => {
  // Capture the id once: the parent passes `record` reactively from the
  // store, so props.record can go null mid-flight if the row is deleted
  // by another action. Read the id synchronously and let the request
  // finish against the captured value rather than crashing on a non-null
  // assertion later.
  const id = props.record?.id;
  if (!id) return;
  testing.value = true;
  testError.value = null;
  try {
    const { data, error } = await callApi<{ ok: boolean; egress_ip?: string; error?: string }>(
      () => api.api.proxies[':id'].test.$post({ param: { id }, json: {} }),
    );
    if (error) { testError.value = error.message; return; }
    if (!data.ok) { testError.value = data.error ?? 'Test failed'; return; }
    // The test endpoint persists egress_ip and last_tested_at into the
    // proxy row; emitting `saved` triggers the parent store reload, which
    // surfaces the new test result through props.record.
    emit('saved');
  } finally {
    testing.value = false;
    testCoolingDown.value = true;
    startTestCooldown();
  }
};

const resetBackoff = async (upstreamId: string) => {
  if (!props.record) return;
  const { error } = await callApi(
    () => api.api.proxies[':id'].backoffs.reset.$post({
      param: { id: props.record!.id },
      json: { upstream_id: upstreamId },
    }),
  );
  if (error) { window.alert(`Reset failed: ${error.message}`); return; }
  emit('saved');
};

const resetAllBackoffs = async () => {
  if (!props.record) return;
  const { error } = await callApi(
    () => api.api.proxies[':id'].backoffs.reset.$post({
      param: { id: props.record!.id },
      json: {},
    }),
  );
  if (error) { window.alert(`Reset failed: ${error.message}`); return; }
  emit('saved');
};

const remove = async () => {
  if (!props.record) return;
  if (!window.confirm(`Delete proxy "${props.record.name}"?`)) return;

  deleting.value = true;
  deleteError.value = null;
  try {
    const { error } = await callApi(
      () => api.api.proxies[':id'].$delete({ param: { id: props.record!.id } }),
    );
    if (error) {
      if (error.status === 409) {
        const refs = (error.raw as ProxyConflictBody | undefined)?.referencing_upstream_ids ?? [];
        deleteError.value = {
          message: 'Cannot delete: referenced by upstream(s)',
          referencingUpstreamIds: refs,
        };
        return;
      }
      deleteError.value = { message: error.message, referencingUpstreamIds: [] };
      return;
    }
    emit('saved');
    await router.push('/dashboard/settings');
  } finally {
    deleting.value = false;
  }
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 space-y-5 animate-in">
    <RouterLink to="/dashboard/settings" class="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-accent-cyan transition-colors">
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m15 18-6-6 6-6" />
      </svg>
      Back to settings
    </RouterLink>

    <h2 class="text-lg font-semibold text-white">
      <template v-if="mode === 'create'">Create Proxy</template>
      <template v-else>Edit Proxy: <span class="text-accent-cyan">{{ record?.name }}</span></template>
    </h2>

    <p v-if="saveError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ saveError }}
    </p>

    <div class="space-y-1.5">
      <label class="block text-xs font-medium text-gray-500">Name</label>
      <Input v-model="name" placeholder="My JP server" />
    </div>

    <div class="space-y-4">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">URL</label>
        <Input
          v-model="url"
          :placeholder="urlPlaceholder"
          :invalid="urlError !== null"
          class="font-mono"
        />
        <div v-if="urlError" class="inline-flex items-center gap-1 rounded-md border border-accent-rose/30 bg-accent-rose/10 px-2 py-1 text-xs text-accent-rose">
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          {{ urlError }}
        </div>
      </div>
      <ProxyConfigForm
        v-if="config"
        v-model="config"
        :url-error="urlError"
      />
      <div v-if="mode === 'edit' && record" class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-gray-500">
        <span>Egress:</span>
        <span v-if="lastEgressIp" class="font-mono text-gray-300">{{ lastEgressIp }}</span>
        <span v-else class="italic">untested</span>
        <span v-if="lastTestedAgo" class="text-gray-600">{{ lastTestedAgo }}</span>
        <Button variant="secondary" size="sm" :loading="testing" :disabled="saving || testCoolingDown" class="ml-auto" @click="test">Test</Button>
      </div>
      <p v-if="mode === 'edit' && testError" class="text-xs text-accent-rose">{{ testError }}</p>
    </div>

    <div class="space-y-1.5">
      <label class="block text-xs font-medium text-gray-500">
        Dial timeout <span class="text-gray-600">(seconds, leave empty for default)</span>
      </label>
      <Input
        v-model="dialTimeoutInput"
        :placeholder="`${DEFAULT_DIAL_TIMEOUT_SECONDS} (default)`"
        :invalid="'error' in dialTimeoutParsed"
        inputmode="numeric"
        class="font-mono"
      />
      <p v-if="'error' in dialTimeoutParsed" class="text-xs text-accent-rose">{{ dialTimeoutParsed.error }}</p>
      <p v-else class="text-xs text-gray-600">
        Hard ceiling on TCP-connect + handshake time before the fallback chain advances and the proxy enters backoff.
      </p>
    </div>

    <template v-if="mode === 'edit' && record">
      <section v-if="activeBackoffs.length > 0">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Backoff state <span class="text-accent-amber">({{ activeBackoffs.length }})</span>
          </h3>
          <button
            v-if="activeBackoffs.length > 1"
            type="button"
            class="text-xs text-gray-400 transition-colors hover:text-accent-rose"
            @click="resetAllBackoffs"
          >Reset all</button>
        </div>
        <div class="space-y-1.5">
          <div
            v-for="row in activeBackoffs"
            :key="row.upstream_id"
            class="flex items-center gap-3 rounded-md border border-white/5 bg-surface-800/40 px-3 py-2"
          >
            <span class="min-w-0 flex-1 truncate text-sm text-gray-300" :title="row.last_error ?? undefined">
              {{ upstreamNames.get(row.upstream_id) ?? row.upstream_id }}
            </span>
            <span class="text-xs text-accent-amber tabular-nums">in {{ formatCountdown(row.expires_at * 1000 - now.getTime(), 'expiring') }}</span>
            <span class="text-xs text-gray-500">fail #{{ row.fail_count }}</span>
            <button
              type="button"
              class="text-xs text-gray-400 transition-colors hover:text-accent-rose"
              @click="resetBackoff(row.upstream_id)"
            >Reset</button>
          </div>
        </div>
      </section>
    </template>

    <div class="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-5">
      <Button :loading="saving" :disabled="testing || testCoolingDown" @click="save">Save</Button>
      <Button variant="secondary" :disabled="saving" @click="cancel">Cancel</Button>

      <template v-if="mode === 'edit' && record">
        <Button variant="danger" class="ml-auto" :loading="deleting" @click="remove">Delete</Button>
      </template>
    </div>

    <div v-if="deleteError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      <p>{{ deleteError.message }}<template v-if="deleteError.referencingUpstreamIds.length === 0">.</template></p>
      <p v-if="deleteError.referencingUpstreamIds.length > 0" class="mt-1 text-xs">
        <template v-for="(id, idx) in deleteError.referencingUpstreamIds" :key="id">
          <RouterLink :to="`/dashboard/upstreams/${id}`" class="underline transition-colors hover:text-white">
            {{ upstreamNames.get(id) ?? id }}
          </RouterLink>
          <span v-if="idx < deleteError.referencingUpstreamIds.length - 1">, </span>
        </template>
      </p>
    </div>

    <Spinner v-if="proxiesStore.loading.value && mode === 'edit'" class="h-4 w-4 text-gray-500" />
  </div>
</template>
