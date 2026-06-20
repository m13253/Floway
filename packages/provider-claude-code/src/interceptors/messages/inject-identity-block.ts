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
  if (!Array.isArray(ctx.payload.system)) {
    throw new Error('inject-identity-block: expected system to be an array (inject-billing-block must run first)');
  }
  const system = ctx.payload.system;
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] };
  return await run();
};
