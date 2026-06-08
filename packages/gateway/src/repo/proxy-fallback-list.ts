// Sentinel value used in `proxy_fallback_list` for "no proxy — connect
// directly". The only legal non-id entry. Centralised here so the
// validator and the dial layer can both reference the same string instead
// of repeating a literal.
export const DIRECT_PROXY_ID = 'direct';

// Defensive copy of `proxyFallbackList`: trimmed, with empty entries dropped
// and duplicates removed while preserving first-seen order. Entries are bare
// proxy ids or the literal 'direct' marker; we do not validate references
// against the proxies table here, that's the API layer's job.
//
// We treat the list as a SET in semantics, even though it's stored as an
// ordered array — a duplicate proxy entry has no meaning beyond "try once",
// so silently dropping repeats keeps the wire shape and the dial-time shape
// in agreement.
export const normalizeProxyFallbackList = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};
