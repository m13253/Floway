import { shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';

// One-shot fetch on dashboard load, cached for the session. Runtime kind is
// fixed per deployment and colo only changes across rare anycast re-routes —
// re-fetching per page navigation has no value.
//
// Consumed only by the proxy fallback list editor. If colo branching spreads
// to other views, that scope assumption needs revisiting.

export interface RuntimeInfo {
  kind: 'cloudflare' | 'node';
  // null when the deployment has no meaningful colo concept (Node without
  // RUNTIME_LOCATION env, or a dev-server CF request landing without
  // `cf.colo` populated).
  colo: string | null;
}

const info = shallowRef<RuntimeInfo | null>(null);
let inflight: Promise<RuntimeInfo> | null = null;

export const useRuntimeInfo = () => {
  const api = useApi();

  // Throws on fetch failure so the caller (a vue-router data loader) surfaces
  // it instead of silently degrading the editor UI to its Node-shaped form.
  // `inflight` dedups concurrent loads from racing in the same page nav.
  // We clear it in `finally` so a failed first attempt doesn't block retry.
  const load = async (): Promise<RuntimeInfo> => {
    if (info.value !== null) return info.value;
    if (inflight !== null) return await inflight;
    inflight = (async () => {
      try {
        const res = await callApi<RuntimeInfo>(() => api.api['runtime-info'].$get());
        if (res.error) throw new Error(`/api/runtime-info: ${res.error.message}`);
        info.value = res.data;
        return res.data;
      } finally {
        inflight = null;
      }
    })();
    return await inflight;
  };

  return { info, load };
};
