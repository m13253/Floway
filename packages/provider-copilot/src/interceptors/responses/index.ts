// Copilot-only Responses workarounds. The boundary chain runs inside
// `provider.callResponses`, so the gateway main flow never knows that
// Copilot has Responses interceptors at all.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withStoreForcedFalse } from './force-store-false.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withImageGenerationStripped } from './strip-image-generation.ts';
import { withServiceTierStripped } from './strip-service-tier.ts';
import { withOutputItemIdsSynchronized } from './synchronize-output-item-ids.ts';
import type { CopilotResponsesBoundaryInterceptor } from './types.ts';

// Order matters: payload-mutating interceptors run first so the header
// interceptors see the final outgoing payload, then header interceptors
// populate the boundary header bag for the upstream call.
export const COPILOT_RESPONSES_BOUNDARY = [
  withInlineImagesCompressed,
  withServiceTierStripped,
  withImageGenerationStripped,
  withStoreForcedFalse,
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
] as const satisfies readonly CopilotResponsesBoundaryInterceptor[];
