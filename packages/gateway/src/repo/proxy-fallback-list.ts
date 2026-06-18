import type { ProxyFallbackEntry } from '@floway-dev/provider';

// Sentinel for "no proxy — connect directly"; the only legal non-id `entry.id`
// value in a proxy_fallback_list entry.
export const DIRECT_PROXY_ID = 'direct';

// Treat the list as a SET by `id` semantics: a duplicate entry has no meaning
// beyond "try once", so silently drop repeats. The first occurrence's `colos`
// whitelist wins on conflict. Colo codes are uppercased so the dial-time
// match against `request.cf.colo` (which CF returns as uppercase) and the
// dashboard's free-form input stay aligned.
export const normalizeProxyFallbackList = (entries: readonly ProxyFallbackEntry[]): ProxyFallbackEntry[] => {
  const seen = new Set<string>();
  const result: ProxyFallbackEntry[] = [];
  for (const raw of entries) {
    const id = raw.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const colos = normalizeColos(raw.colos);
    result.push(colos === undefined ? { id } : { id, colos });
  }
  return result;
};

const normalizeColos = (colos: readonly string[] | undefined): string[] | undefined => {
  if (colos === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of colos) {
    const c = raw.trim().toUpperCase();
    if (c === '' || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.length === 0 ? undefined : out;
};

// True when the entry is active under the data-plane request's current colo.
// A null `currentColo` (Node without RUNTIME_LOCATION) means the deployment
// has no colo concept, so every entry is honoured as written.
export const entryMatchesColo = (entry: ProxyFallbackEntry, currentColo: string | null): boolean => {
  if (currentColo === null) return true;
  if (entry.colos === undefined || entry.colos.length === 0) return true;
  return entry.colos.includes(currentColo);
};
