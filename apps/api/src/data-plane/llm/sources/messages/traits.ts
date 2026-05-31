import { messagesSourceInterceptors } from './interceptors/index.ts';
import { respondMessages } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext } from '../request-context.ts';
import { jsonUpstreamErrorResult, sourceErrorResult, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateMessagesViaChatCompletions, translateMessagesViaResponses, viaTranslation } from '@floway-dev/translate';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const parseAnthropicBeta = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return values.length > 0 ? values : undefined;
};

export const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, 'anthropic_beta')) return 'anthropic_beta';
  if (Object.hasOwn(record, 'betas')) return 'betas';
  return undefined;
};

export const bodyAnthropicBetaResponse = (param: string): Response =>
  Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );

// `headers` is intentionally passed by reference: target-portable source-side
// Copilot interceptors (compact / interaction-id) mutate the original Messages
// invocation's `headers` bag, and the planner may pick a non-Messages target
// (Responses or Chat Completions). Each translated emit closure rebuilds an
// invocation in the target shape — without sharing the same `headers`
// reference, those source-side mutations would land on the dropped Messages
// invocation and never reach the upstream HTTP call.
//
// Native Messages-only identity rewrites, such as Claude Code's messages-proxy
// header shape, must gate on `targetApi === 'messages'` inside the interceptor
// before writing into this shared bag.
//
// `anthropicBeta` deliberately does NOT cross protocols: it is an inbound
// Messages concept, and the Responses / Chat Completions target emitters do
// not consume it.
const messagesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
  anthropicBeta: readonly string[] | undefined,
  headers: Record<string, string>,
) => ({
  sourceApi: 'messages' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers,
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
  if (endpoints.includes('messages')) return 'messages';
  if (endpoints.includes('responses')) return 'responses';
  if (endpoints.includes('chat_completions')) return 'chat-completions';
  return null;
};

// Maps a serve failure to the Messages (Anthropic) error envelope, shared with
// the count_tokens path which answers in the same shape under a different
// endpoint label. `internal` is excluded — it is rendered with a stack trace by
// the caller, not as a flat envelope.
export const messagesFailureEnvelope = (
  failure: Exclude<LlmServeFailure, { kind: 'internal' }>,
  endpoint: string,
): { status: number; body: { type: 'error'; error: { type: string; message: string } } } => {
  const [status, type, message]: [number, string, string] = (() => {
    switch (failure.kind) {
    case 'item-not-found': return [400, 'invalid_request_error', `Item with id '${failure.itemId}' not found.`];
    case 'routing-unavailable': return [400, 'invalid_request_error', failure.message];
    case 'model-missing': return [404, 'not_found_error', `Model ${failure.model} is not available on any configured upstream.`];
    case 'model-unsupported': return [400, 'invalid_request_error', `Model ${failure.model} does not support the ${endpoint} endpoint.`];
    }
  })();
  return { status, body: { type: 'error', error: { type, message } } };
};

const renderMessagesFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<MessagesStreamEventData>> => {
  if (failure.kind === 'internal') return sourceErrorResult<MessagesStreamEventData>(failure.error, { sourceApi: 'messages', internalStatus: 502 });
  const { status, body } = messagesFailureEnvelope(failure, '/messages');
  return jsonUpstreamErrorResult(status, body);
};

export const messagesTraits: LlmSourceTraits<readonly MessagesMessage[], MessagesStreamEventData> = {
  renderFailure: renderMessagesFailure,
  respond: async ({ c, result, request, wantsStream, downstreamAbortController }) =>
    await respondMessages(c, result, wantsStream, request, downstreamAbortController),
  setup: async c => {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);
    const wantsStream = payload.stream === true;
    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    return {
      request,
      items: payload.messages,
      responsesItemsView: messagesViaResponsesItemsView,
      wantsStream,
      store: undefined,
      model: payload.model,
      downstreamAbortController,
      pickTarget,
      attempt: async ({ binding, target, model, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        attemptPayload.messages = await rewriteItems(attemptPayload.messages);
        const sharedHeaders: Record<string, string> = {};
        const invocation: MessagesInvocation = messagesInvocation(binding, target, model, attemptPayload, anthropicBeta, sharedHeaders);
        const emits: Record<LlmTargetApi, SourceEmit<MessagesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<MessagesStreamEventData>>>> = {
          messages: async srcPayload => await emitToMessages({ ...invocation, payload: srcPayload }, request),
          responses: viaTranslation(translateMessagesViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(messagesInvocation(binding, 'responses', model, tgtPayload, undefined, sharedHeaders), request)),
          'chat-completions': viaTranslation(translateMessagesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(messagesInvocation(binding, 'chat-completions', model, tgtPayload, undefined, sharedHeaders), request)),
        };
        const interceptors = [...messagesSourceInterceptors, ...(binding.sourceInterceptors?.messages ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};
