import type { Context } from 'hono';

import { messagesSourceInterceptors } from './interceptors/index.ts';
import { respondMessages } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import { serveStoredResponsesItems, type StoredItemsFailure, type StoredItemsServeDescriptor } from '../stored-responses-items-serve.ts';
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

const renderMessagesFailure = (failure: StoredItemsFailure): ExecuteResult<ProtocolFrame<MessagesStreamEventData>> => {
  switch (failure.kind) {
  case 'diagnostic':
    return jsonUpstreamErrorResult(failure.diagnostic.status, failure.diagnostic.body);
  case 'model-missing':
    return openAiMissingModelResult(failure.model);
  case 'model-unsupported':
    return openAiUnsupportedEndpointResult(failure.model, '/messages');
  case 'source-error':
    return sourceErrorResult<MessagesStreamEventData>(failure.error, { sourceApi: 'messages', internalStatus: 502 });
  }
};

export const serveMessages = async (c: Context): Promise<Response> => {
  const descriptor: StoredItemsServeDescriptor<readonly MessagesMessage[], MessagesStreamEventData> = {
    request: createRequestContext(c, undefined, false),
    renderFailure: renderMessagesFailure,
    respond: async ({ result, request, wantsStream, commit, downstreamAbortController }) =>
      await respondMessages(c, result, wantsStream, request, downstreamAbortController, commit),
    setup: async () => {
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
        view: messagesViaResponsesItemsView,
        wantsStream,
        store: undefined,
        model: payload.model,
        downstreamAbortController,
        pickTarget,
        attempt: async ({ binding, target, model, rewriteItems }) => {
          const attemptPayload = structuredClone(payload);
          attemptPayload.model = model;
          attemptPayload.messages = (await rewriteItems(attemptPayload.messages)) as MessagesMessage[];
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

  return await serveStoredResponsesItems(descriptor);
};
