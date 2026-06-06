import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { BackoffRow, ProxyRecord } from '../api/types.ts';

// Module-scoped cache mirrors useUpstreams: the settings card and the
// upstream-edit fallback widget both read the same list, so a single fetch on
// page entry serves both surfaces. Backoff rows are loaded alongside so each
// row can render its current pause state without a follow-up request.
const proxies = shallowRef<ProxyRecord[] | null>(null);
const backoffs = shallowRef<BackoffRow[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

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

  return { proxies, backoffs, loading, error, load };
};
