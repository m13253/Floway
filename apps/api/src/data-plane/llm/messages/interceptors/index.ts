import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor } from './types.ts';
import { withMessagesWebSearchShim } from './web-search-shim.ts';

// Unified Messages interceptor list. All entries are attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.candidate.binding.enabledFlags.has(flagId)`).
//
// Order follows source-then-target semantics collapsed into a single chain:
//   - withMessagesWebSearchShim: registered first so its replay rewrite and
//     intercept loop wrap the rest of the chain. Unconditional for translated
//     targets (Responses / Chat Completions cannot carry Anthropic server
//     tools); gated by `messages-web-search-shim` for native Messages targets.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withMessagesWebSearchShim,
  withReasoningDisabledOnForcedToolChoice,
];

// count_tokens shares the Messages payload-shape interceptors but runs against
// the count_tokens upstream call, which returns a raw `Response` rather than
// an event stream. The shipped Messages interceptors all inspect post-`run()`
// event streams, so neither composes with count_tokens; the list stays empty
// today. Kept as a separate readonly array so `messagesAttempt.countTokens`
// has a clear extension point and so provider-supplied count-tokens
// interceptors can be spread in later.
export const messagesCountTokensInterceptors: readonly MessagesCountTokensInterceptor[] = [];
