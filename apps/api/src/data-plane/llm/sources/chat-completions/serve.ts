import type { Context } from 'hono';

import { chatCompletionsSourceInterceptors } from './interceptors/index.ts';
import { respondChatCompletions } from './respond.ts';
import { listModelProviders, resolveModelForProvider } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import { StoredResponsesItemsDiagnosticError } from '../responses/items/errors.ts';
import { noopResponsesItemsCommit, type ResponsesItemsCommit, storeResponsesOutputItems } from '../responses/items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from '../responses/items/request-plan.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
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

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    return null;
  };

  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const preparedStoredItems = await prepareStoredResponsesItemsForSource(payload.messages, request.apiKeyId ?? null, chatCompletionsViaResponsesItemsView);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) return Response.json(preparedDiagnostic.body, { status: preparedDiagnostic.status });

    let result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>> | undefined;
    let commitStoredItems: ResponsesItemsCommit = noopResponsesItemsCommit;
    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), preparedStoredItems);
    let resolvedModelId = payload.model;
    let sawModel = false;
    if (providerPlan.type === 'error') {
      result = jsonUpstreamErrorResult(providerPlan.diagnostic.status, providerPlan.diagnostic.body);
    } else for (const provider of providerPlan.providers) {
      const resolved = await resolveModelForProvider(provider, payload.model);
      if (!resolved) continue;

      sawModel = true;
      resolvedModelId = resolved.id;
      const binding = resolved.binding;
      const target = pickTarget(binding.upstreamModel.upstreamEndpoints);
      if (!target) continue;

      const attemptPayload = structuredClone(payload);
      attemptPayload.model = resolvedModelId;
      attemptPayload.messages = await rewriteStoredResponsesItemsForProvider(attemptPayload.messages, preparedStoredItems, binding, chatCompletionsViaResponsesItemsView);

      const invocation: ChatCompletionsInvocation = chatInvocation(binding, target, resolvedModelId, attemptPayload);

      const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ChatCompletionChunk>>>> = {
        'chat-completions': async srcPayload => await emitToChatCompletions({ ...invocation, payload: srcPayload }, request),
        messages: viaTranslation(translateChatCompletionsViaMessages, async (tgtPayload: MessagesPayload) =>
          await emitToMessages(chatInvocation(binding, 'messages', resolvedModelId, tgtPayload), request)),
        responses: viaTranslation(translateChatCompletionsViaResponses, async (tgtPayload: ResponsesPayload) =>
          await emitToResponses(chatInvocation(binding, 'responses', resolvedModelId, tgtPayload), request)),
      };

      const rawResult = await runInterceptors(invocation, request, [...chatCompletionsSourceInterceptors, ...(binding.sourceInterceptors?.chatCompletions ?? [])], () =>
        emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      if (rawResult.type === 'events') {
        const stored = storeResponsesOutputItems(rawResult.events, chatCompletionsViaResponsesItemsView, { targetApi: invocation.targetApi, upstream: invocation.upstream, store: invocation.payload.store }, request, wantsStream);
        result = { ...rawResult, events: stored.events };
        commitStoredItems = stored.commit;
      } else {
        result = rawResult;
      }
      break;
    }

    result ??= sawModel ? openAiUnsupportedEndpointResult(resolvedModelId, '/chat/completions') : openAiMissingModelResult(resolvedModelId);

    return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, request, downstreamAbortController, commitStoredItems);
  } catch (error) {
    if (error instanceof StoredResponsesItemsDiagnosticError) {
      return Response.json(error.diagnostic.body, { status: error.diagnostic.status });
    }
    return await respondChatCompletions(
      c,
      sourceErrorResult(error, {
        sourceApi: 'chat-completions',
        internalStatus: 502,
      }),
      false,
      includeUsageChunk,
      request, downstreamAbortController,
      noopResponsesItemsCommit,
    );
  }
};
