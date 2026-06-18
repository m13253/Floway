import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';

// Anthropic's official aliases map to the dated CC models we ship in our
// catalog. Real Claude Code clients sometimes post the alias instead of the
// dated id (mirrors `claude-3-5-sonnet-latest` → `claude-3-5-sonnet-20241022`
// behavior). Aliases passed through unchanged confuse the upstream's per-
// model rate-limit / pricing routing — Anthropic treats `claude-sonnet-4-5`
// as "the latest, whatever it is right now" and that drifts across our
// dashboard's per-model usage view. Pinning here keeps the model_key
// consistent.
//
// Anthropic's published alias table (verified 2026-06-19):
//   https://docs.claude.com/en/docs/about-claude/models/overview
const MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

export const pinDatedModelId = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const dated = MODEL_ALIASES[ctx.payload.model];
  if (dated !== undefined) {
    ctx.payload = { ...ctx.payload, model: dated };
  }
  return await run();
};
