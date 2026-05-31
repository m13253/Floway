// Shared helpers for the `disabledPublicModelIds` JSON column on upstreams.
//
// `normalizeDisabledPublicModelIds` returns a defensive copy: trimmed, with
// empty entries dropped and duplicates removed while preserving first-seen
// order. It sits below the wire-form validator and is called on both
// persistence paths (where the array shape was already validated) and in-memory
// clone paths (where this is the only line of defense), mirroring
// `normalizeFlagOverrides`.
//
// JSON parsing for the D1 read path lives in `d1.ts::parseDisabledPublicModelIds`
// because the error chain there carries the row id and JSON-shape diagnostics
// specific to that path.
export const normalizeDisabledPublicModelIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new Error(`disabledPublicModelIds entries must be strings, got ${typeof raw}`);
    }
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

// Wire-form parser for the import path. An absent field means "nothing disabled"
// (older exports predate the column), which is the genuine empty-set semantics
// rather than a fabricated fallback. A present value must be a string array.
export const parseDisabledPublicModelIdsWire = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('disabled_public_model_ids must be an array of strings');
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('disabled_public_model_ids entries must be strings');
  }
  return normalizeDisabledPublicModelIds(value as string[]);
};
