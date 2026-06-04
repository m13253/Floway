import { withReasoningEncryptedContentCanonicalized } from './canonicalize-encrypted-content.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';
import type { ResponsesInterceptor } from './types.ts';

export type { ResponsesInterceptor, ResponsesInvocation } from './types.ts';

// Unified Responses interceptor list. All entries are attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.candidate.binding.enabledFlags.has(flagId)`).
//
// Order follows today's source-then-target semantics now collapsed into a
// single chain:
//   - withReasoningEncryptedContentCanonicalized: registered first so it pins
//     the final (post-retry) event stream's encrypted_content.
//   - withCyberPolicyRetried: gated by `retry-cyber-policy`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered LAST
//     so each gets the final say on the outbound wire body.
//
// NOTE: The source-side server-tool interceptors (web-search shim and
// image-generation shim) are not yet included here. Those interceptors depend
// on `StatefulResponsesStore` and `scheduleBackground`, which are not exposed
// on `GatewayCtx`. They will be ported once `GatewayCtx` or
// `ResponsesInvocation` is extended to carry those dependencies, or an
// alternative mechanism is designed for them.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withReasoningEncryptedContentCanonicalized,
  withCyberPolicyRetried,
  withReasoningDisabledOnForcedToolChoice,
  withVendorDeepseekResponsesNormalize,
  withVendorQwenResponsesNormalize,
];
