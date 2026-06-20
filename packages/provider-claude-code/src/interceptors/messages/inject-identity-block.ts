import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';

// Appends the canonical CC identity block at system[1]. The chain order in
// ./index.ts puts `injectBillingBlock` ahead of us, so `ctx.payload.system`
// is always a fresh array by the time this interceptor runs. The runtime
// `Array.isArray` guard below fences that invariant structurally — if the
// chain order is ever rearranged, the throw surfaces the misuse loudly
// instead of silently `.push`-ing onto a non-array.
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
