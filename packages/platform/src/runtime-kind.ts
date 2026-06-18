// Discriminates the runtime the gateway is currently running in. Each
// `apps/platform-*` entry calls `initRuntimeKind` at bootstrap with its own
// kind; downstream code reads it via `getRuntimeKind` to specialise
// runtime-shaped behaviour (e.g. "is colo a meaningful concept here").

export type RuntimeKind = 'cloudflare' | 'node';

let _kind: RuntimeKind | null = null;

export const initRuntimeKind = (kind: RuntimeKind): void => {
  _kind = kind;
};

export const getRuntimeKind = (): RuntimeKind => {
  if (!_kind) throw new Error('Runtime kind not initialized — call initRuntimeKind() first');
  return _kind;
};
