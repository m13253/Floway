import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Two stores share this core. The DEFAULT view (`useModelsStore`) backs the
// Models page + Keys page; it stays scoped to the caller's effective
// upstream cap, mirroring data-plane visibility — admins who self-restrict
// see only what their own account would receive at the data plane. The
// RAW view (`useRawModelsStore`) backs the alias editor surfaces (target
// combobox, shadow detection, kind-mismatch warning, no-target-available
// warning); it requests `include_unlisted=true` to surface every id the
// resolver would accept AND `gateway_wide=true` because the editor's job
// is to configure gateway state, not browse the admin's per-account
// data-plane view. The server gates `gateway_wide=true` on admin —
// non-admin sessions never reach these editor surfaces in the first
// place (`AliasesSettingsCard` and `AliasEditDialog` mount only on
// `requiresAdmin` pages).
const makeStore = (params: { includeAliases: boolean; includeUnlisted?: boolean; gatewayWide?: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  return () => {
    const api = useApi();

    const load = async () => {
      loading.value = true;
      error.value = null;
      const query: { aliases?: 'false'; include_unlisted?: 'true'; gateway_wide?: 'true' } = {};
      if (!params.includeAliases) query.aliases = 'false';
      if (params.includeUnlisted) query.include_unlisted = 'true';
      if (params.gatewayWide) query.gateway_wide = 'true';
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
export const useRawModelsStore = makeStore({ includeAliases: false, includeUnlisted: true, gatewayWide: true });
