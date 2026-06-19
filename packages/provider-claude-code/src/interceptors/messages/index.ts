// Claude Code re-mimicry chain. Runs only on the re-mimicry path (callMessages
// short-circuits to passthrough when the inbound request is already CC-shaped).
//
// Order matters:
//   1. synthesize-metadata-user-id      runs first so session_id derives from
//                                       the operator's real first user
//                                       message rather than the synthetic
//                                       <system>...</system> pair that hoist
//                                       (step 2) injects when system text
//                                       is present. Two conversations sharing
//                                       a system prompt must NOT share a
//                                       session id, or prompt-cache routing
//                                       and rate-limit accounting collapse.
//   2. hoist-user-system-to-messages    captures the caller's system text into
//                                       a synthetic user/assistant pair so the
//                                       three mimicry blocks below own
//                                       `payload.system`.
//   3. inject-billing-block             system[0]: per-request cc_version /
//                                       cch=00000 fingerprint.
//   4. inject-identity-block            system[1]: canonical CC identity text.
//   5. inject-default-template          system[2]: cached boilerplate template
//                                       (carries cache_control:ephemeral).
//
// The on-wire `model` field is set in `fetch.ts` from
// `opts.model.providerData.upstreamModelId` so the chain never has to rewrite
// it — the catalog id is already Anthropic's public alias and the dated
// upstream id is read straight off the resolved model.

import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './inject-billing-block.ts';
import { injectDefaultTemplate } from './inject-default-template.ts';
import { injectIdentityBlock } from './inject-identity-block.ts';
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

export type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';

export const claudeCodeMessagesChain = <TResult>(): readonly Interceptor<ClaudeCodeMessagesBoundaryCtx, object, TResult>[] => [
  synthesizeMetadataUserId,
  hoistUserSystemToMessages,
  injectBillingBlock,
  injectIdentityBlock,
  injectDefaultTemplate,
];
