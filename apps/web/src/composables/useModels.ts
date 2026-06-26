import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Two stores share this core: the default `/api/models` view (real models
// + synthesised alias entries merged into one list) backs the dashboard
// models tab and surfaces that want the externally-visible catalog; the
// raw view (`?aliases=false`) backs the alias settings surfaces (edit
// dialog target combobox, shadow detection, kind-mismatch warning) that
// need to see the underlying catalog without the alias-overwrites-real-id
// collapse the wire shape applies. The two singletons live separately so
// each kind has its own cache.
const makeStore = (params: { includeAliases: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  return () => {
    const api = useApi();

    const load = async () => {
      loading.value = true;
      error.value = null;
      const query = params.includeAliases ? {} : { aliases: 'false' as const };
      const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get({ query }));
      loading.value = false;
      if (err) {
        error.value = err.message;
        return;
      }
      models.value = data?.data ?? [];
    };

    return { models, loading, error, load };
  };
};

export const useModelsStore = makeStore({ includeAliases: true });
export const useRawModelsStore = makeStore({ includeAliases: false });
