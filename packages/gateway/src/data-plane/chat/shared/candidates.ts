// Chat-side facade over the shared `resolveModelCandidates` helper. The chat
// surfaces (chat-completions, messages, responses, gemini) all share the
// `ChatTargetApi` target descriptor; the passthrough surfaces use
// `ModelEndpointKey` directly. Both ride on the same resolve helper — see
// `data-plane/providers/registry.ts`.

import type { ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

export type ChatCandidate = ProviderCandidate;
