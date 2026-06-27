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
// raw view backs the alias settings surfaces (edit dialog target
// combobox, shadow detection, kind-mismatch warning, no-target-available
// warning) that need to see the underlying catalog without the
// alias-overwrites-real-id collapse the wire shape applies. The raw view
// requests `include_unlisted=true` so addressable-but-not-listed ids
// (Copilot variant ids, prefix-form alternates, provider-side redirects)
// surface alongside the listed catalog — the alias dialog combobox
// suggests every id the data-plane resolver would accept, and the
// shadow/no-target checks see the same surface the resolver does.
const makeStore = (params: { includeAliases: boolean; includeUnlisted?: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  return () => {
    const api = useApi();

    const load = async () => {
      loading.value = true;
      error.value = null;
      const query: { aliases?: 'false'; include_unlisted?: 'true' } = {};
      if (!params.includeAliases) query.aliases = 'false';
      if (params.includeUnlisted) query.include_unlisted = 'true';
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
export const useRawModelsStore = makeStore({ includeAliases: false, includeUnlisted: true });
