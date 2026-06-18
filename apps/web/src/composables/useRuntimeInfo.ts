import { shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';

// One-shot fetch on dashboard load, cached for the session. Runtime kind is
// fixed per deployment and colo only changes across very rare anycast
// re-routes — refreshing per page navigation has no value.
//
// Used only by the proxy fallback list editor (which surfaces colo-scoped
// entries on Cloudflare deployments). No other view should reach into this
// store; if colo branching spreads, this scope assumption needs revisiting.

export interface RuntimeInfo {
  kind: 'cloudflare' | 'node';
  // null when the deployment has no meaningful colo concept (Node without
  // RUNTIME_LOCATION env, or a dev-server CF request landing without
  // `cf.colo` populated).
  colo: string | null;
}

const info = shallowRef<RuntimeInfo | null>(null);
const loading = shallowRef(false);
const error = shallowRef<string | null>(null);
let inflight: Promise<void> | null = null;

export const useRuntimeInfo = () => {
  const api = useApi();

  const load = async (): Promise<void> => {
    if (info.value !== null) return;
    if (inflight !== null) {
      await inflight;
      return;
    }
    loading.value = true;
    error.value = null;
    inflight = (async () => {
      const res = await callApi<RuntimeInfo>(() => api.api['runtime-info'].$get());
      if (res.error) {
        error.value = res.error.message;
        return;
      }
      info.value = res.data;
    })();
    try {
      await inflight;
    } finally {
      loading.value = false;
      inflight = null;
    }
  };

  return { info, loading, error, load };
};
