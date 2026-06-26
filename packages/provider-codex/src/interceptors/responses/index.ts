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
// Each interceptor is generic over the terminal result type so the same chain
// definition fits both the streaming generate terminal and the compact
// terminal, which share the same boundary ctx and dispatch on `ctx.action`.
// Codex interceptors are pure payload/header mutators, so the streaming
// variant returns its terminal result directly (no per-frame lift/lower).
export const codexResponsesChain = <TResult>(): readonly Interceptor<ResponsesBoundaryCtx, object, TResult>[] => [
  injectDefaultInstructions,
  stripUnsupportedFields,
  injectSessionId,
];
