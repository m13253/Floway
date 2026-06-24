import { withReasoningEncryptedContentCanonicalized } from './canonicalize-encrypted-content.ts';
import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import { withResponsesServerToolShim } from './server-tool-shim.ts';
import { imageGenerationServerTool } from './server-tools/image-generation.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import type { ResponsesInterceptor } from './types.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';

// Unified Responses interceptor list. All entries are attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.candidate.binding.enabledFlags.has(flagId)`).
//
// Order matters: earlier entries wrap later ones.
//   - withResponsesServerToolShim: runs outermost so it wraps the full
//     multi-turn ReAct loop around the rest of the chain.
//   - withReasoningEncryptedContentCanonicalized: pins the final
//     (post-retry) event stream's encrypted_content.
//   - withCyberPolicyRetried: gated by `retry-cyber-policy`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withDemoteDeveloperToSystem: gated by `demote-developer-to-system`.
//     Runs before withInterleavedSystemDemotedToUser so when both flags are
//     on, a `developer` role first lands as `system`, then any system that
//     ends up after the leading run is rewritten to `user` — the chain
//     `developer → system → user` covers the strictest upstreams.
//   - withInterleavedSystemDemotedToUser: gated by
//     `demote-interleaved-system-to-user`. Walks the input items and
//     rewrites any `role: 'system'` message item that follows the leading
//     contiguous system run to `role: 'user'` so upstreams that reject
//     mid-stream system messages still accept the body.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered LAST
//     so each gets the final say on the outbound wire body.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withResponsesServerToolShim([
    webSearchServerTool,
    imageGenerationServerTool,
  ]),
  withReasoningEncryptedContentCanonicalized,
  withCyberPolicyRetried,
  withReasoningDisabledOnForcedToolChoice,
  withDemoteDeveloperToSystem,
  withInterleavedSystemDemotedToUser,
  withVendorDeepseekResponsesNormalize,
  withVendorQwenResponsesNormalize,
];
