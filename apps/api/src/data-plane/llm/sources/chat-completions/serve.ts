import type { Context } from 'hono';

import { chatCompletionsSourceInterceptors } from './interceptors/index.ts';
import { respondChatCompletions } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import { serveStoredResponsesItems, type SourceServeTrait } from '../stored-responses-items-serve.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload, Message as ChatMessage } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateChatCompletionsViaMessages, translateChatCompletionsViaResponses, viaTranslation } from '@floway-dev/translate';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const chatInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'chat-completions' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers: {} as Record<string, string>,
});

const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
  if (endpoints.includes('chat_completions')) return 'chat-completions';
  if (endpoints.includes('messages')) return 'messages';
  if (endpoints.includes('responses')) return 'responses';
  return null;
};

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;
  const trait: SourceServeTrait<readonly ChatMessage[], ChatMessage[], ChatCompletionChunk> = {
    request: createRequestContext(c, undefined, false),
    parse: async () => {
      const payload = await c.req.json<ChatCompletionsPayload>();
      includeUsageChunk = payload.stream_options?.include_usage === true;
      const wantsStream = payload.stream === true;
      const downstreamAbortController = wantsStream ? new AbortController() : undefined;
      trait.request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
      return { payload, items: payload.messages, wantsStream, model: payload.model, view: chatCompletionsViaResponsesItemsView, downstreamAbortController };
    },
    pickTarget,
    buildAttempt: ({ binding, target, model, payload, rewrittenItems }) => {
      const attemptPayload = structuredClone(payload as ChatCompletionsPayload);
      attemptPayload.model = model;
      attemptPayload.messages = rewrittenItems;
      const invocation: ChatCompletionsInvocation = chatInvocation(binding, target, model, attemptPayload);
      const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ChatCompletionChunk>>>> = {
        'chat-completions': async srcPayload => await emitToChatCompletions({ ...invocation, payload: srcPayload }, trait.request),
        messages: viaTranslation(translateChatCompletionsViaMessages, async (tgtPayload: MessagesPayload) =>
          await emitToMessages(chatInvocation(binding, 'messages', model, tgtPayload), trait.request)),
        responses: viaTranslation(translateChatCompletionsViaResponses, async (tgtPayload: ResponsesPayload) =>
          await emitToResponses(chatInvocation(binding, 'responses', model, tgtPayload), trait.request)),
      };
      const interceptors = [...chatCompletionsSourceInterceptors, ...(binding.sourceInterceptors?.chatCompletions ?? [])];
      return {
        targetApi: invocation.targetApi,
        upstream: invocation.upstream,
        store: attemptPayload.store,
        run: async () => await runInterceptors(invocation, trait.request, interceptors, () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens })),
      };
    },
    diagnosticResponse: diagnostic => Response.json(diagnostic.body, { status: diagnostic.status }),
    planErrorResult: diagnostic => jsonUpstreamErrorResult(diagnostic.status, diagnostic.body),
    missingModelResult: model => openAiMissingModelResult(model),
    unsupportedModelResult: model => openAiUnsupportedEndpointResult(model, '/chat/completions'),
    sourceErrorResult: error => sourceErrorResult<ChatCompletionChunk>(error, { sourceApi: 'chat-completions', internalStatus: 502 }),
    respond: async ({ result, wantsStream, commit, downstreamAbortController }) =>
      await respondChatCompletions(c, result, wantsStream, includeUsageChunk, trait.request, downstreamAbortController, commit),
  };

  return await serveStoredResponsesItems(trait);
};
