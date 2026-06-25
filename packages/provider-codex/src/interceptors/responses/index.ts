// Codex-only Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has Responses interceptors at all.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { injectSessionId } from './inject-session-id.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

// Order rationale: none of the three interceptors below read or write a field
// the others touch, so order is positional only. inject-session-id last is
// conventional but not load-bearing — it hashes only `instructions + first
// user-message text`, neither of which is mutated by the other two.
//
// Each interceptor is generic over its terminal result type so the same
// definition would still fit if the chain ever needed to split. Today the
// codex `callResponses` runs this chain exactly once per request — the
// terminal is always `ProviderResponsesResult`, whose discriminated union
// covers both `action: 'generate'` (streaming events) and `action: 'compact'`
// (envelope value). Codex interceptors are pure payload/header mutators that
// never inspect the terminal, so there is no per-frame lift/lower seam.
export const codexResponsesChain = <TResult>(): readonly Interceptor<ResponsesBoundaryCtx, object, TResult>[] => [
  injectDefaultInstructions,
  stripUnsupportedFields,
  injectSessionId,
];
