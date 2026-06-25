import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';

export interface AliasMatchResult {
  readonly alias: ModelAlias;
}

// Lookup an alias for the (post-prefix-strip) lookupId against the upstream's
// id. An empty `upstreamIds` filter on the alias means "match any upstream";
// a non-empty filter must include the upstream's id.
export const matchAlias = (
  lookupId: string,
  upstreamId: string,
  aliases: readonly ModelAlias[],
): AliasMatchResult | undefined => {
  const hit = aliases.find(a => a.alias === lookupId);
  if (!hit) return undefined;
  if (hit.upstreamIds.length > 0 && !hit.upstreamIds.includes(upstreamId)) return undefined;
  return { alias: hit };
};
