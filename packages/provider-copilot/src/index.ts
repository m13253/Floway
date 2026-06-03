export { createCopilotProvider } from './provider.ts';
export {
  CLAUDE_AGENT_USER_AGENT,
  clearCopilotTokenCache,
  copilotFetch,
  CopilotTokenFetchError,
  githubHeaders,
  isCopilotAccountType,
  isCopilotTokenFetchError,
  type CopilotAccountType,
  type CopilotFetchOptions,
} from './auth.ts';
export {
  createCopilotUpstream,
  type CopilotUpstream,
} from './upstream.ts';
export { fetchCopilotModels } from './fetch-models.ts';
export type { CopilotRawModel } from './types.ts';
export {
  emptyLedger,
  mergeLedger,
  projectLedger,
  type CopilotLedger,
} from './ledger.ts';
export { mergeClaudeVariants } from './merge-claude-variants.ts';
export {
  copilotPublicModelId,
  copilotRequestedModelAliasTarget,
} from './model-name.ts';
export {
  hasContext1mBeta,
  resolveCopilotRawModel,
  type ModelSelectionHints,
} from './model-selection.ts';
export {
  pricingForCopilotModelKey,
  pricingForCopilotPublicModelId,
} from './pricing.ts';
// Per-interceptor symbols (`with*`, `rewrite*`) share function names across
// protocol stacks — `withInlineImagesCompressed` exists in chat-completions/,
// messages/, and responses/, etc. — so a flat re-export would collide. Tests
// import them by sub-path via the package's `./*` exports map (e.g.
// `@floway-dev/provider-copilot/interceptors/messages/compress-images`).
