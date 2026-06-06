// Defensive copy of `proxyFallbackList`: trimmed, with empty entries dropped
// and duplicates removed while preserving first-seen order. Mirrors the
// `disabledPublicModelIds` normalizer — entries are bare proxy ids or the
// literal 'direct' marker; we do not validate references against the proxies
// table here, that's the API layer's job.
export const normalizeProxyFallbackList = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new Error(`proxyFallbackList entries must be strings, got ${typeof raw}`);
    }
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};
