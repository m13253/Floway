import { computed, ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { BackoffRow, ProxyRecord } from '../api/types.ts';

// Module-scoped cache mirrors useUpstreams; settings card and fallback editor share one fetch.
const proxies = shallowRef<ProxyRecord[] | null>(null);
const backoffs = shallowRef<BackoffRow[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// Group `backoffs` by `proxy_id` once, so every consumer (settings card,
// fallback panel, edit page) reads the (proxy_id → rows[]) lookup off the
// same Map instead of re-folding the array per render.
const backoffsByProxyId = computed<Map<string, BackoffRow[]>>(() => {
  const map = new Map<string, BackoffRow[]>();
  for (const row of backoffs.value ?? []) {
    const list = map.get(row.proxy_id);
    if (list) list.push(row);
    else map.set(row.proxy_id, [row]);
  }
  return map;
});

export const useProxiesStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const [listRes, backoffsRes] = await Promise.all([
      callApi<ProxyRecord[]>(() => api.api.proxies.$get()),
      callApi<BackoffRow[]>(() => api.api.proxies.backoffs.$get()),
    ]);
    if (listRes.error) error.value = listRes.error.message;
    else if (listRes.data) proxies.value = [...listRes.data].sort((a, b) => a.sort_order - b.sort_order);
    if (backoffsRes.error && !error.value) error.value = backoffsRes.error.message;
    else if (backoffsRes.data) backoffs.value = backoffsRes.data;
    loading.value = false;
  };

  return { proxies, backoffs, backoffsByProxyId, loading, error, load };
};
