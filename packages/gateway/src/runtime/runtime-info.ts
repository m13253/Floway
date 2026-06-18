import { getEnv, getRuntimeKind, type RuntimeKind } from '@floway-dev/platform';

export interface RuntimeInfo {
  kind: RuntimeKind;
  // null when the deployment has no meaningful colo concept (Node without
  // RUNTIME_LOCATION env) or when a CF request happens to land without a
  // populated `cf.colo` (dev-server miniflare, hand-issued internal calls).
  colo: string | null;
}

export const getCurrentColo = (request: Request): string | null => {
  if (getRuntimeKind() === 'cloudflare') {
    const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
    return typeof colo === 'string' && colo.length > 0 ? colo : null;
  }
  // On Node we surface the operator-provided RUNTIME_LOCATION env value so a
  // multi-instance deployment can still mark each instance with its region
  // and reuse the colo-aware proxy fallback feature. An unset env means we
  // don't pretend the concept exists.
  const env = getEnv('RUNTIME_LOCATION');
  return env.length > 0 ? env : null;
};

export const getRuntimeInfo = (request: Request): RuntimeInfo => ({
  kind: getRuntimeKind(),
  colo: getCurrentColo(request),
});
