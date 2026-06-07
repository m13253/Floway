<script setup lang="ts">
import { Spinner } from '@floway-dev/ui';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { BackoffRow, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import ProxyRow from './ProxyRow.vue';

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
  ordered.value = list ? [...list].sort((a, b) => a.sort_order - b.sort_order) : [];
}, { immediate: true });

// Per-proxy in-flight + last error for the Test button. Plain Maps keyed by id;
// Vue tracks Map reassignments rather than internal mutation, so replace on every update.
const testInFlight = ref<Map<string, boolean>>(new Map());
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

const backoffsByProxyId = computed<Map<string, BackoffRow[]>>(() => {
  const map = new Map<string, BackoffRow[]>();
  for (const row of proxiesStore.backoffs.value ?? []) {
    const list = map.get(row.proxy_id);
    if (list) list.push(row);
    else map.set(row.proxy_id, [row]);
  }
  return map;
});

const persistReorder = async (next: ProxyRecord[]) => {
  const patches = next
    .map((p, i) => ({ id: p.id, oldOrder: p.sort_order, newOrder: i }))
    .filter(({ oldOrder, newOrder }) => oldOrder !== newOrder);
  if (patches.length === 0) return;
  const results = await Promise.all(
    patches.map(({ id, newOrder }) =>
      callApi(() => api.api.proxies[':id'].$patch({ param: { id }, json: { sort_order: newOrder } })),
    ),
  );
  const failed = results.find(r => r.error);
  if (failed?.error) window.alert(`Reorder failed: ${failed.error.message}`);
  emit('changed');
};

const moveProxy = async (id: string, direction: -1 | 1) => {
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
  const idx = ordered.value.findIndex(p => p.id === id);
  const target = idx + direction;
  return idx === -1 || target < 0 || target >= ordered.value.length;
};

const testProxy = async (record: ProxyRecord) => {
  testInFlight.value = setMapEntry(testInFlight.value, record.id, true);
  testError.value = setMapEntry(testError.value, record.id, null);
  // Anchor defaults to ipify on the server when the body is empty.
  const { data, error } = await callApi<{ ok: boolean; egress_ip?: string; error?: string }>(
    () => api.api.proxies[':id'].test.$post({ param: { id: record.id }, json: {} }),
  );
  if (error) {
    testError.value = setMapEntry(testError.value, record.id, error.message);
  } else if (data && !data.ok) {
    testError.value = setMapEntry(testError.value, record.id, data.error ?? 'Test failed');
  } else {
    emit('changed');
  }
  // 3s cooldown so a double-click can't double-spend the anchor's IP echo.
  setTimeout(() => {
    testInFlight.value = setMapEntry(testInFlight.value, record.id, false);
  }, 3000);
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
      const refs = (error.raw as { referencing_upstream_ids?: string[] })?.referencing_upstream_ids ?? [];
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

    <p v-if="ordered.length === 0" class="text-sm text-gray-500">
      No proxies configured. Add a proxy to route upstream traffic through it.
    </p>

    <div v-else class="space-y-2">
      <ProxyRow
        v-for="proxy in ordered"
        :key="proxy.id"
        :proxy="proxy"
        :backoffs-for-proxy="backoffsByProxyId.get(proxy.id) ?? []"
        :upstream-names="upstreamNames"
        :move-up-disabled="moveDisabled(proxy.id, -1)"
        :move-down-disabled="moveDisabled(proxy.id, 1)"
        :test-in-flight="testInFlight.get(proxy.id) ?? false"
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
