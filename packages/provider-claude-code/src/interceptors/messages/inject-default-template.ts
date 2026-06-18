import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { DEFAULT_TEMPLATE_BLOCK } from '../../system-blocks.ts';

// Appends the cached default-template block at system[2]. The block already
// carries `cache_control: { type: 'ephemeral' }` so Anthropic's prompt cache
// keys on the (billing, identity, template) triplet up to here; the billing
// block intentionally sits BEFORE this cache breakpoint so its per-request
// fingerprint never invalidates the cached prefix. Chain order in ./index.ts
// guarantees `system` is already a fresh array when this runs.
export const injectDefaultTemplate = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as Exclude<typeof ctx.payload.system, string | undefined>;
  ctx.payload = { ...ctx.payload, system: [...system, DEFAULT_TEMPLATE_BLOCK] };
  return await run();
};
