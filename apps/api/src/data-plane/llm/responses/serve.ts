import { responsesAttempt } from './attempt.ts';
import { renderResponsesFailure } from './errors.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './items/store.ts';
import { planResponsesRouting } from './routing.ts';
import { expandPreviousResponseId } from './serve-prep.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ResponsesServeGenerateArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  // HTTP defaults to 'append'; WS overrides per-message based on `payload.store`.
  // The cross-protocol translation-in path never reaches this entry — it goes
  // straight into `responsesAttempt.generate`.
  readonly snapshotMode?: ResponsesSnapshotMode;
}

export interface ResponsesServeCompactArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
}

export const responsesServe = {
  generate: async (args: ResponsesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, store, snapshotMode = 'append' } = args;
    const prepared = await expandPreviousResponseId(payload, store);
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: prepared.model,
      sourceApi: 'responses',
      pickTarget: endpoints =>
        endpoints.responses ? 'responses'
          : endpoints.messages ? 'messages'
            : endpoints.chatCompletions ? 'chat-completions'
              : null,
    });
    const decision = await planResponsesRouting({ payload: prepared, candidates, store });
    if (decision.kind === 'failure') return renderResponsesFailure(decision.failure, 'generate');
    // Stage the user-supplied input from the original payload — not the
    // expansion's `item_reference` prefix — so the next-turn snapshot picks
    // up the new user items in addition to the prior snapshot history.
    // Runs after routing so any `item_reference` in user-supplied input has
    // its target row loaded by the affinity walk.
    await stageUserInputItems(payload.input, store);

    // Any non-throwing attempt result — events, upstream-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream. Iteration only loops if the candidate list is empty.
    for (const candidate of decision.candidates) {
      return await responsesAttempt.generate({ payload: prepared, ctx, store, candidate, snapshotMode });
    }
    return renderResponsesFailure(
      sawModel
        ? { kind: 'model-unsupported', model: prepared.model }
        : { kind: 'model-missing', model: prepared.model },
      'generate',
    );
  },

  compact: async (args: ResponsesServeCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, store } = args;
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present we expand it the same way generate does so the
    // upstream sees the same item_reference + current input shape.
    const prepared = await expandPreviousResponseId(payload, store);
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: prepared.model,
      sourceApi: 'responses',
      pickTarget: endpoints => endpoints.responses ? 'responses' : null,
    });
    const decision = await planResponsesRouting({ payload: prepared, candidates, store });
    if (decision.kind === 'failure') return renderResponsesFailure(decision.failure, 'compact');
    await stageUserInputItems(payload.input, store);

    // The first candidate's result IS the answer — upstream-error and
    // internal-error envelopes are final, not a hint to try another
    // upstream. Iteration only loops if the candidate list is empty.
    for (const candidate of decision.candidates) {
      return await responsesAttempt.compact({ payload: prepared, ctx, store, candidate });
    }
    return renderResponsesFailure(
      sawModel
        ? { kind: 'model-unsupported', model: prepared.model }
        : { kind: 'model-missing', model: prepared.model },
      'compact',
    );
  },
};

// Materializes the user-supplied input (string or array) into Responses items
// and stages them so the snapshot picks them up alongside the prior history
// and this turn's output. Mirrors the contract the routing/affinity walk
// already honors via `loadInputItems` — staging is the write-side companion.
const stageUserInputItems = async (input: ResponsesPayload['input'], store: StatefulResponsesStore): Promise<void> => {
  const items: ResponsesInputItem[] = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : [...input];
  await store.stageInputItems(items);
  await store.refreshTouchedItems();
};
