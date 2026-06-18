import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';

// Appends the canonical CC identity block at system[1]. Ordering with the
// billing block (system[0]) and default template (system[2]) is enforced by
// the chain order in ./index.ts; this interceptor only knows how to push
// onto whatever array inject-billing-block already established.
export const injectIdentityBlock = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = Array.isArray(ctx.payload.system) ? ctx.payload.system : [];
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] };
  return await run();
};
