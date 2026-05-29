import type { Context } from 'hono';

import { geminiSourceInterceptors } from './interceptors/index.ts';
import { respondGemini } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type GeminiInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, sourceErrorResult } from '../execute.ts';
import type { StoredResponsesItemsDiagnostic } from '../responses/items/errors.ts';
import { serveStoredResponsesItems, type SourceServeTrait } from '../stored-responses-items-serve.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiGenerateContentRequest, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses, viaTranslation } from '@floway-dev/translate';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const googleRpcStatusForHttpStatus = (status: number): string => {
  switch (status) {
  case 400:
    return 'INVALID_ARGUMENT';
  case 404:
    return 'NOT_FOUND';
  case 500:
    return 'INTERNAL';
  default:
    return status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
  }
};

const geminiErrorResponse = (status: number, message: string): Response =>
  Response.json(
    { error: { code: status, message, status: googleRpcStatusForHttpStatus(status) } },
    { status },
  );

const geminiErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, {
    error: { code: status, message, status: googleRpcStatusForHttpStatus(status) },
  });

const geminiInvocation = <TPayload>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'gemini' as const,
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

// Gemini has no native upstream target in the provider API; prefer Chat
// Completions, then Messages, then Responses.
const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
  if (endpoints.includes('chat_completions')) return 'chat-completions';
  if (endpoints.includes('messages')) return 'messages';
  if (endpoints.includes('responses')) return 'responses';
  return null;
};

export const serveGemini = async (c: Context, model: string, wantsStream: boolean): Promise<Response> => {
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const diagnosticResponse = (diagnostic: StoredResponsesItemsDiagnostic): Response => geminiErrorResponse(diagnostic.status, diagnostic.message);
  const trait: SourceServeTrait<readonly GeminiContent[], GeminiContent[], GeminiStreamEvent> = {
    request: createRequestContext(c, downstreamAbortController?.signal, wantsStream),
    parse: async () => {
      const payload = await c.req.json<GeminiGenerateContentRequest>();
      return { payload, items: payload.contents ?? [], wantsStream, model, view: geminiViaResponsesItemsView, downstreamAbortController };
    },
    pickTarget,
    buildAttempt: ({ binding, target, model: resolvedModelId, payload, rewrittenItems }) => {
      const attemptPayload = structuredClone(payload as GeminiGenerateContentRequest);
      if (attemptPayload.contents !== undefined) attemptPayload.contents = rewrittenItems;
      // Gemini source payload has no `model` field on the request body; the
      // invocation carries the resolved id for telemetry/dispatch use.
      const invocation: GeminiInvocation = geminiInvocation(binding, target, resolvedModelId, attemptPayload);
      const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>> = {
        messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
          await emitToMessages(geminiInvocation(binding, 'messages', resolvedModelId, tgtPayload), trait.request)),
        responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) =>
          await emitToResponses(geminiInvocation(binding, 'responses', resolvedModelId, tgtPayload), trait.request)),
        'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
          await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload), trait.request)),
      };
      const interceptors = [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])];
      return {
        targetApi: invocation.targetApi,
        upstream: invocation.upstream,
        store: undefined,
        run: async () => await runInterceptors(invocation, trait.request, interceptors, () =>
          emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens })),
      };
    },
    diagnosticResponse,
    planErrorResult: diagnostic => geminiErrorResult(diagnostic.status, diagnostic.message),
    missingModelResult: model => geminiErrorResult(404, `Model ${model} is not available on any configured upstream.`),
    unsupportedModelResult: model => geminiErrorResult(400, `Model ${model} does not support the Gemini generateContent endpoint.`),
    sourceErrorResult: error => sourceErrorResult<GeminiStreamEvent>(error, { sourceApi: 'gemini', internalStatus: 500 }),
    respond: async ({ result, wantsStream, commit, downstreamAbortController }) =>
      await respondGemini(c, result, wantsStream, trait.request, downstreamAbortController, commit),
  };

  return await serveStoredResponsesItems(trait);
};
