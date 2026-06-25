import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ModelAlias } from '../api/types.ts';

// Module-scoped cache so concurrent callers share one fetch — mirrors the
// proxies store pattern: settings tabs that mount in parallel reuse a single
// in-flight request instead of fan-out per-component.
const aliases = shallowRef<ModelAlias[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

export const useModelAliases = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const { data, error: err } = await callApi<ModelAlias[]>(() => api.api.aliases.$get());
    loading.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
    aliases.value = data;
  };

  return { aliases, loading, error, load };
};
