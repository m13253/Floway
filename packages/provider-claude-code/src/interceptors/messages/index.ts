// Claude Code re-mimicry chain. Runs only on the re-mimicry path (callMessages
// short-circuits to passthrough when the inbound request is already CC-shaped).
//
// Order matters:
//   1. hoist-user-system-to-messages    captures the caller's system text into
//                                       a synthetic user/assistant pair so the
//                                       three mimicry blocks below own
//                                       `payload.system`.
//   2. inject-billing-block             system[0]: per-request cc_version /
//                                       cch=00000 fingerprint.
//   3. inject-identity-block            system[1]: canonical CC identity text.
//   4. inject-default-template          system[2]: cached boilerplate template
//                                       (carries cache_control:ephemeral).
//   5. pin-dated-model-id               alias → dated id so model_key matches
//                                       what /v1/models advertises.
//   6. synthesize-metadata-user-id      fills metadata.user_id with the new
//                                       JSON-form CC identity if absent.

import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './inject-billing-block.ts';
import { injectDefaultTemplate } from './inject-default-template.ts';
import { injectIdentityBlock } from './inject-identity-block.ts';
import { pinDatedModelId } from './pin-dated-model-id.ts';
import { synthesizeMetadataUserId } from './synthesize-metadata-user-id.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

export type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';

export const claudeCodeMessagesChain = <TResult>(): readonly Interceptor<ClaudeCodeMessagesBoundaryCtx, object, TResult>[] => [
  hoistUserSystemToMessages,
  injectBillingBlock,
  injectIdentityBlock,
  injectDefaultTemplate,
  pinDatedModelId,
  synthesizeMetadataUserId,
];
