import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';

// Appends the canonical CC identity block at system[1]. The chain order in
// ./index.ts guarantees `injectBillingBlock` has already set
// `ctx.payload.system` to a fresh array, so we push onto it directly without
// re-checking the shape.
export const injectIdentityBlock = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as Exclude<typeof ctx.payload.system, string | undefined>;
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] };
  return await run();
};
