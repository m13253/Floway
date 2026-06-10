<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import ProxyRow from './ProxyRow.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ProxyConflictBody, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { Spinner } from '@floway-dev/ui';

const emit = defineEmits<{
  'add': [];
  'edit': [record: ProxyRecord];
  'changed': [];
}>();

const api = useApi();
const proxiesStore = useProxiesStore();
const upstreamsStore = useUpstreamsStore();

const ordered = ref<ProxyRecord[]>([]);
watch(proxiesStore.proxies, list => {
  ordered.value = list ? [...list] : [];
}, { immediate: true });

// Per-proxy in-flight, post-test cooldown, and last error for the Test button.
// `testInFlight` clears the moment the API call resolves so the spinner stops
// spinning once the response is in hand; `testCoolingDown` is a separate 3s
// guard that disables the button without making it look busy. Plain Maps keyed
// by id; Vue tracks Map reassignments rather than internal mutation, so replace
// on every update.
const testInFlight = ref<Map<string, boolean>>(new Map());
const testCoolingDown = ref<Map<string, boolean>>(new Map());
const testError = ref<Map<string, string | null>>(new Map());

const setMapEntry = <V>(map: Map<string, V>, key: string, value: V): Map<string, V> => {
  const next = new Map(map);
  next.set(key, value);
  return next;
};

const upstreamNames = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const u of upstreamsStore.upstreams.value ?? []) map.set(u.id, u.name);
  return map;
});

const backoffsByProxyId = proxiesStore.backoffsByProxyId;

// Reorder is persisted as a single atomic POST: the server writes every
// row's sort_order in one statement, so a half-applied write is impossible
// and a concurrent insert/delete fails the whole operation rather than
// leaving a hybrid order. On any failure, re-fetch from the server so the
// local UI matches whatever the truth now is.
//
// `reorderInFlight` guards `moveProxy` so a rapid sequence of arrow clicks
// can't fan out into overlapping requests, which would otherwise race the
// server-side rewrite of `sort_order` against a stale client snapshot.
// Dropping the click is fine: the move-arrow buttons reflect
// `reorderInFlight` and the operator retries once the operation lands.
const reorderInFlight = ref(false);
const persistReorder = async (next: ProxyRecord[]) => {
  if (next.every((p, i) => p.sort_order === i)) return;
  reorderInFlight.value = true;
  try {
    const { error } = await callApi(
      () => api.api.proxies.reorder.$post({ json: { ids: next.map(p => p.id) } }),
    );
    if (error) {
      window.alert(`Reorder failed: ${error.message}`);
      await proxiesStore.load();
      emit('changed');
      return;
    }
    emit('changed');
  } finally {
    reorderInFlight.value = false;
  }
};

const moveProxy = async (id: string, direction: -1 | 1) => {
  if (reorderInFlight.value) return;
  const list = [...ordered.value];
  const idx = list.findIndex(p => p.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= list.length) return;
  const tmp = list[idx]!;
  list[idx] = list[target]!;
  list[target] = tmp;
  ordered.value = list;
  await persistReorder(list);
};

const moveDisabled = (id: string, direction: -1 | 1) => {
  if (reorderInFlight.value) return true;
  const idx = ordered.value.findIndex(p => p.id === id);
  const target = idx + direction;
  return idx === -1 || target < 0 || target >= ordered.value.length;
};

// Per-row cooldown timer. Plain setTimeout because useTimeoutFn started
// inside a click handler runs OUTSIDE setup's EffectScope and so wouldn't
// auto-cancel on unmount; explicit clearTimeout in onBeforeUnmount keeps
// the lifecycle deterministic.
const cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
const startTestCooldown = (id: string): void => {
  const existing = cooldownTimers.get(id);
  if (existing) clearTimeout(existing);
  testCoolingDown.value = setMapEntry(testCoolingDown.value, id, true);
  cooldownTimers.set(
    id,
    setTimeout(() => {
      testCoolingDown.value = setMapEntry(testCoolingDown.value, id, false);
      cooldownTimers.delete(id);
    }, 3000),
  );
};
onBeforeUnmount(() => {
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
});

const testProxy = async (record: ProxyRecord) => {
  testInFlight.value = setMapEntry(testInFlight.value, record.id, true);
  testError.value = setMapEntry(testError.value, record.id, null);
  try {
    // Anchor defaults to ipify on the server when the body is empty.
    const { data, error } = await callApi<{ ok: boolean; egress_ip?: string; error?: string }>(
      () => api.api.proxies[':id'].test.$post({ param: { id: record.id }, json: {} }),
    );
    if (error) {
      testError.value = setMapEntry(testError.value, record.id, error.message);
    } else if (!data.ok) {
      testError.value = setMapEntry(testError.value, record.id, data.error ?? 'Test failed');
    } else {
      emit('changed');
    }
  } finally {
    testInFlight.value = setMapEntry(testInFlight.value, record.id, false);
    // 3s cooldown so a double-click can't double-spend the anchor's IP echo.
    startTestCooldown(record.id);
  }
};

const resetBackoffs = async (record: ProxyRecord) => {
  const { error } = await callApi(
    () => api.api.proxies[':id'].backoffs.reset.$post({ param: { id: record.id }, json: {} }),
  );
  if (error) {
    window.alert(`Reset failed: ${error.message}`);
    return;
  }
  emit('changed');
};

const deleteProxy = async (record: ProxyRecord) => {
  if (!window.confirm(`Delete proxy "${record.name}"?`)) return;
  const { error } = await callApi(() => api.api.proxies[':id'].$delete({ param: { id: record.id } }));
  if (error) {
    if (error.status === 409) {
      const refs = (error.raw as ProxyConflictBody | undefined)?.referencing_upstream_ids ?? [];
      const names = refs.map(id => upstreamNames.value.get(id) ?? id).join(', ');
      window.alert(`This proxy is referenced by upstreams: ${names}. Remove it from those upstreams first.`);
      return;
    }
    window.alert(`Delete failed: ${error.message}`);
    return;
  }
  emit('changed');
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-white font-semibold mb-1">Proxies</h3>
        <p class="text-sm text-gray-400">Outbound proxies referenced by per-upstream fallback lists.</p>
      </div>
      <button class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap" @click="emit('add')">Add Proxy</button>
    </div>

    <!-- Surface a list-load error so an empty render after a failure isn't
         confused with the "no proxies configured" empty state. The store
         already exposes the message; this card is its only consumer. -->
    <p v-if="proxiesStore.error.value" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      Failed to load proxies: {{ proxiesStore.error.value }}
    </p>

    <p v-if="!proxiesStore.error.value && ordered.length === 0" class="text-sm text-gray-500">
      No proxies configured. Add a proxy to route upstream traffic through it.
    </p>

    <div v-else-if="ordered.length > 0" class="space-y-2">
      <ProxyRow
        v-for="proxy in ordered"
        :key="proxy.id"
        :proxy="proxy"
        :backoffs-for-proxy="backoffsByProxyId.get(proxy.id) ?? []"
        :upstream-names="upstreamNames"
        :move-up-disabled="moveDisabled(proxy.id, -1)"
        :move-down-disabled="moveDisabled(proxy.id, 1)"
        :test-in-flight="testInFlight.get(proxy.id) ?? false"
        :test-cooling-down="testCoolingDown.get(proxy.id) ?? false"
        :test-error="testError.get(proxy.id) ?? null"
        @test="testProxy(proxy)"
        @reset-backoffs="resetBackoffs(proxy)"
        @move-up="moveProxy(proxy.id, -1)"
        @move-down="moveProxy(proxy.id, 1)"
        @edit="emit('edit', proxy)"
        @delete="deleteProxy(proxy)"
      />
    </div>

    <Spinner v-if="proxiesStore.loading.value && ordered.length > 0" class="mt-3 h-4 w-4 text-gray-500" />
  </div>
</template>
