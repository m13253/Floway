<script setup lang="ts">
// URL validation runs on every keystroke via parseProxyUri. Import from
// the package's /url and /proxy-config subpaths rather than the barrel —
// the barrel pulls in runProxiedRequest and the userspace TLS stack,
// which transitively depend on Node's crypto and inflate the dashboard
// bundle. The parser itself is pure (no SocketDial, no TLS), so the
// subpath gives live feedback without dial-time code. The gateway re-
// parses on POST/PATCH, so this client check is not load-bearing for
// security.

import { parseProxyUri } from '@floway-dev/proxy/url';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { DEFAULT_DIAL_DEADLINE_MS } from '@floway-dev/proxy/constants';
import { Button, Input, Spinner } from '@floway-dev/ui';
import { useNow, useTimeoutFn } from '@vueuse/core';
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import type { BackoffRow, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { formatCountdown, formatRelativeAgo } from '../../utils/format-countdown.ts';

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
// Local "fresh test result" override. The page's parent re-derives `record`
// from the proxies-store array on every store reload, which means any
// sibling action (sibling card refresh, the useNow tick driving an upstream
// component, ...) hands us a new `record` object identity. Reading these
// fields straight from `props.record` would otherwise be fine; the override
// exists so a successful Test() click reflects the new IP immediately,
// before the next store reload pulls it in from the server.
const localEgressIp = ref<string | null>(null);
const localTestedAt = ref<number | null>(null);
const lastEgressIp = computed(() => localEgressIp.value ?? props.record?.last_egress_ip ?? null);
const lastTestedAt = computed(() => localTestedAt.value ?? props.record?.last_tested_at ?? null);

// Per-proxy dial-stage deadline. Stored as a string to make "empty" the
// canonical "use default" signal; coerced to a number on save. The
// initial seed runs once: the parent re-mounts the component (via
// :key="record.id") whenever the row changes, so a parent-store reload
// against the SAME id must not clobber whatever the operator is typing.
const DEFAULT_DIAL_TIMEOUT_SECONDS = Math.floor(DEFAULT_DIAL_DEADLINE_MS / 1000);
const dialTimeoutInput = ref<string>(props.record?.dial_timeout_seconds === null || props.record?.dial_timeout_seconds === undefined ? '' : String(props.record.dial_timeout_seconds));

const dialTimeoutParsed = computed<{ value: number | null } | { error: string } | null>(() => {
  const raw = dialTimeoutInput.value.trim();
  if (raw === '') return { value: null };
  if (!/^[1-9][0-9]*$/.test(raw)) return { error: 'Whole seconds, > 0' };
  const n = Number(raw);
  if (n < 1 || n > 600) return { error: 'Must be between 1 and 600 seconds' };
  return { value: n };
});

const saving = ref(false);
const saveError = ref<string | null>(null);

const testing = ref(false);
const testError = ref<string | null>(null);

const deleting = ref(false);
const deleteError = ref<{ message: string; referencingUpstreamIds: string[] } | null>(null);

// Empty string returns null (neutral) so a fresh draft does not flash an error before the user types.
const parsed = computed<{ ok: true; config: ProxyConfig } | { ok: false; error: string } | null>(() => {
  const trimmed = url.value.trim();
  if (!trimmed) return null;
  try {
    return { ok: true, config: parseProxyUri(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const KIND_LABELS: Record<ProxyConfig['kind'], string> = {
  'http': 'HTTP',
  'socks5': 'SOCKS5',
  'ss': 'Shadowsocks',
  'ss2022': 'Shadowsocks 2022',
  'trojan': 'Trojan',
  'vless-tcp': 'VLESS / TLS',
  'vless-ws': 'VLESS / WebSocket',
  'reality': 'VLESS / REALITY',
};

const parseLabel = computed(() => {
  if (!parsed.value || !parsed.value.ok) return '';
  const c = parsed.value.config;
  // HTTP variant carries a TLS bit rather than a separate kind; surface it
  // in the label so an operator can tell https-CONNECT from plain http.
  const kindLabel = c.kind === 'http' && c.tls ? 'HTTPS' : KIND_LABELS[c.kind];
  return `${kindLabel} · ${c.host}:${c.port}`;
});

const backoffsForProxy = computed<BackoffRow[]>(() => {
  if (!props.record) return [];
  const all = proxiesStore.backoffs.value ?? [];
  return all.filter(b => b.proxy_id === props.record!.id);
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
  return [...backoffsForProxy.value]
    .filter(b => b.expires_at > nowSec)
    .sort((a, b) => a.expires_at - b.expires_at);
});

const lastTestedAgo = computed<string | null>(() => {
  if (lastTestedAt.value === null) return null;
  return formatRelativeAgo(now.value.getTime() - lastTestedAt.value * 1000);
});

const { start: startTestCooldown } = useTimeoutFn(
  () => { testing.value = false; },
  3000,
  // Manually triggered after the request resolves; useTimeoutFn auto-
  // cancels on unmount so a navigation mid-cooldown doesn't write to a
  // gone component.
  { immediate: false },
);

const save = async () => {
  saveError.value = null;
  const trimmedName = name.value.trim();
  const trimmedUrl = url.value.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }
  if (!trimmedUrl) { saveError.value = 'URL is required'; return; }
  if (parsed.value && !parsed.value.ok) {
    saveError.value = `Invalid proxy URI: ${parsed.value.error}`;
    return;
  }
  if (dialTimeoutParsed.value && 'error' in dialTimeoutParsed.value) {
    saveError.value = `Dial timeout: ${dialTimeoutParsed.value.error}`;
    return;
  }
  const dialTimeoutSeconds = dialTimeoutParsed.value && 'value' in dialTimeoutParsed.value ? dialTimeoutParsed.value.value : null;

  saving.value = true;
  try {
    if (props.mode === 'create') {
      const { data, error } = await callApi<ProxyRecord>(
        () => api.api.proxies.$post({ json: { name: trimmedName, url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds } }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved');
      if (data) await router.push(`/dashboard/proxies/${data.id}`);
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
  if (!props.record) return;
  testing.value = true;
  testError.value = null;
  try {
    const { data, error } = await callApi<{ ok: boolean; egress_ip?: string; error?: string }>(
      () => api.api.proxies[':id'].test.$post({ param: { id: props.record!.id }, json: {} }),
    );
    if (error) { testError.value = error.message; return; }
    if (data && !data.ok) { testError.value = data.error ?? 'Test failed'; return; }
    if (data?.egress_ip) {
      // Wire format is unix seconds, not millis; the next store reload
      // overwrites these from the server-confirmed value.
      localEgressIp.value = data.egress_ip;
      localTestedAt.value = Math.floor(Date.now() / 1000);
    }
    emit('saved');
  } finally {
    // 3s cooldown so a double-click can't double-spend the anchor's IP echo.
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
  await proxiesStore.load();
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
  await proxiesStore.load();
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
        const refs = (error.raw as { referencing_upstream_ids?: string[] })?.referencing_upstream_ids ?? [];
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

    <div class="space-y-1.5">
      <label class="block text-xs font-medium text-gray-500">URL</label>
      <Input
        v-model="url"
        placeholder="vless://uuid@host:443?type=tcp&security=reality&pbk=..."
        :invalid="parsed?.ok === false"
        class="font-mono"
      />
      <div v-if="parsed?.ok === true" class="inline-flex items-center gap-1 rounded-md border border-accent-emerald/30 bg-accent-emerald/10 px-2 py-1 text-xs text-accent-emerald">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="m5 13 4 4L19 7" />
        </svg>
        {{ parseLabel }}
      </div>
      <div v-else-if="parsed?.ok === false" class="inline-flex items-center gap-1 rounded-md border border-accent-rose/30 bg-accent-rose/10 px-2 py-1 text-xs text-accent-rose">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
        {{ parsed.error }}
      </div>
      <div v-if="mode === 'edit' && record" class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-gray-500">
        <span>Egress:</span>
        <span v-if="lastEgressIp" class="font-mono text-gray-300">{{ lastEgressIp }}</span>
        <span v-else class="italic">untested</span>
        <span v-if="lastTestedAgo" class="text-gray-600">{{ lastTestedAgo }}</span>
        <Button variant="secondary" size="sm" :loading="testing" class="ml-auto" @click="test">Test</Button>
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
        :invalid="dialTimeoutParsed !== null && 'error' in dialTimeoutParsed"
        inputmode="numeric"
        class="font-mono"
      />
      <p v-if="dialTimeoutParsed && 'error' in dialTimeoutParsed" class="text-xs text-accent-rose">{{ dialTimeoutParsed.error }}</p>
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
      <Button :loading="saving" @click="save">Save</Button>
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
