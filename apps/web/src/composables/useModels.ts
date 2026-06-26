import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Default `/api/models` view: real models + synthesised alias entries
// merged into one list. Backs the /dashboard/models tab and any surface
// that wants the gateway's externally-visible catalog.
const models = ref<ControlPlaneModel[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

export const useModelsStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get({ query: {} }));
    loading.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
    models.value = data?.data ?? [];
  };

  return { models, loading, error, load };
};

// Raw catalog view: real models only, no alias merging. Backs the alias
// settings surfaces (edit dialog target combobox, shadow detection,
// kind-mismatch warning) — those need to see the underlying catalog
// without the alias-overwrites-real-id collapse the wire-shape applies.
const rawModels = ref<ControlPlaneModel[] | null>(null);
const rawLoading = ref(false);
const rawError = ref<string | null>(null);

export const useRawModelsStore = () => {
  const api = useApi();

  const load = async () => {
    rawLoading.value = true;
    rawError.value = null;
    const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get({ query: { aliases: 'false' } }));
    rawLoading.value = false;
    if (err) {
      rawError.value = err.message;
      return;
    }
    rawModels.value = data?.data ?? [];
  };

  return { models: rawModels, loading: rawLoading, error: rawError, load };
};
