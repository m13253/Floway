import { responsesTarget } from './attempt.ts';
import { renderResponsesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { classifyResponsesItemAffinity } from '../items/affinity.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { ModelCandidate } from '../shared/candidates.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

// Thrown when a request names a `previous_response_id` that the store cannot
// resolve. The HTTP/WS entry layer catches this and renders the OpenAI-shaped
// 400 body verbatim — clients (codex) compare it byte-for-byte against
// upstream OpenAI's `previous_response_not_found` envelope, so the rendering
// stays at the entry boundary instead of being folded into the generic
// ChatServeFailure renderer.
//
// Verbatim payload cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
export class PreviousResponseNotFoundError extends Error {
  readonly previousResponseId: string;

  constructor(previousResponseId: string) {
    super(`Previous response with id '${previousResponseId}' not found.`);
    this.name = 'PreviousResponseNotFoundError';
    this.previousResponseId = previousResponseId;
  }
}

// Stitches a previous turn's snapshot items in front of this turn's input,
// then drops `previous_response_id` from the payload (the snapshot id is a
// gateway concept and never reaches the upstream wire). Native-entry only:
// translated payloads coming in from another protocol's attempt never carry
// `previous_response_id`, so this prep runs in serve and not in attempt.
export const expandPreviousResponseId = async (
  payload: ResponsesPayload,
  store: StatefulResponsesStore,
): Promise<ResponsesPayload> => {
  const previousResponseId = payload.previous_response_id;
  if (previousResponseId === undefined || previousResponseId === null) return payload;

  const snapshot = await store.loadSnapshot(previousResponseId);
  if (snapshot === null) throw new PreviousResponseNotFoundError(previousResponseId);

  const currentInput = typeof payload.input === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: payload.input }]
    : [...payload.input];

  const { previous_response_id: _previous, ...rest } = payload;
  return {
    ...rest,
    input: [
      ...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })),
      ...currentInput,
    ],
  };
};

// A bare-string Responses `input` is wrapped into a synthetic user message
// so staging and affinity-walk both see it as a real item. The affinity walk
// still receives an empty `sourceItems` array since a string carries no
// item references — only the staged form matters.
const materializeInput = (input: ResponsesPayload['input']): {
  sourceItems: readonly ResponsesInputItem[];
  items: readonly ResponsesInputItem[];
} => typeof input === 'string'
  ? { sourceItems: [], items: [{ type: 'message', role: 'user', content: input }] }
  : { sourceItems: input, items: input };

export type ResponsesServePlan =
  | { readonly kind: 'failure'; readonly result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> }
  | { readonly kind: 'ready'; readonly prepared: ResponsesPayload; readonly candidate: ModelCandidate };

// Runs the shared serve-side prep both `responsesServe.generate` and
// `responsesServe.compact` need before dispatching to `responsesAttempt`:
// expand any `previous_response_id`, enumerate candidates, narrow by item
// affinity (so a stored reasoning/compaction item nails the request to the
// upstream that produced it), stage the user input, and pick the first
// candidate. Returns a rendered failure result when no candidate is viable
// so the caller can surface it directly without re-deriving the model-error
// branch.
export const prepareResponsesServePlan = async (args: {
  readonly payload: ResponsesPayload;
  readonly ctx: ChatGatewayCtx;
}): Promise<ResponsesServePlan> => {
  const { payload, ctx } = args;
  const { store } = ctx;
  const prepared = await expandPreviousResponseId(payload, store);
  const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
    upstreamIds: ctx.upstreamIds,
    model: prepared.model,
    kind: 'chat',
    scheduler: ctx.backgroundScheduler,
    currentColo: ctx.currentColo,
  });
  const viable = candidates.filter(c => responsesTarget.canServe(c.model.endpoints));
  const { sourceItems, items: inputItemsToStage } = materializeInput(prepared.input);
  const decision = await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store,
    candidates: viable,
    inputItemsToStage,
  });
  if (isChatServeFailure(decision)) return { kind: 'failure', result: renderResponsesFailure(decision) };
  // Stage the user-supplied input from the original payload — not the
  // expansion's `item_reference` prefix — so the next-turn snapshot picks
  // up the new user items in addition to the prior snapshot history.
  // Runs after narrowing so any `item_reference` in user-supplied input has
  // its target row loaded by the affinity walk.
  const { items: itemsToStage } = materializeInput(payload.input);
  await store.stageInputItems(itemsToStage);
  await store.refreshTouchedItems();

  // Any non-throwing attempt result — events, api-error, or
  // internal-error — IS the answer for this request: an upstream 4xx/5xx
  // from the first viable candidate is final, not a hint to try another
  // upstream.
  const [candidate] = decision;
  if (candidate === undefined) {
    return {
      kind: 'failure',
      result: renderResponsesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: prepared.model, failedUpstreams }
          : { kind: 'model-missing', model: prepared.model, failedUpstreams },
      ),
    };
  }
  return { kind: 'ready', prepared, candidate };
};
