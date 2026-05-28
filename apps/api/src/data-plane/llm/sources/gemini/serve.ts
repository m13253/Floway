import type { Context } from 'hono';

import { geminiSourceInterceptors } from './interceptors/index.ts';
import { respondGemini } from './respond.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { listModelProviders, resolveModelForProvider } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type GeminiInvocation, type LlmTargetApi, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, sourceErrorResult } from '../execute.ts';
import { StoredResponsesItemsDiagnosticError } from '../responses/items/errors.ts';
import { storeResponsesOutputItems } from '../responses/items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from '../responses/items/request-plan.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses, viaTranslation } from '@floway-dev/translate';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const missingGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(404, {
    error: {
      code: 404,
      message: `Model ${model} is not available on any configured upstream.`,
      status: 'NOT_FOUND',
    },
  });

const unsupportedGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(400, {
    error: {
      code: 400,
      message: `Model ${model} does not support the Gemini generateContent endpoint.`,
      status: 'INVALID_ARGUMENT',
    },
  });

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

const geminiInvocation = <TPayload>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
  responsesNewItems: StoredResponsesItem[],
) => ({
  sourceApi: 'gemini' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  responsesNewItems,
  payload,
  headers: {} as Record<string, string>,
});

export const serveGemini = async (c: Context, model: string, wantsStream: boolean): Promise<Response> => {
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

  // Gemini has no native upstream target in the provider API; prefer Chat
  // Completions, then Messages, then Responses.
  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    return null;
  };

  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();
    const preparedStoredItems = await prepareStoredResponsesItemsForSource(payload.contents ?? [], request.apiKeyId ?? null, geminiViaResponsesItemsView);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) {
      return Response.json(
        {
          error: {
            code: preparedDiagnostic.status,
            message: preparedDiagnostic.message,
            status: googleRpcStatusForHttpStatus(preparedDiagnostic.status),
          },
        },
        { status: preparedDiagnostic.status },
      );
    }

    let result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | undefined;
    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), preparedStoredItems);
    let resolvedModelId = model;
    let sawModel = false;
    if (providerPlan.type === 'error') {
      result = jsonUpstreamErrorResult(providerPlan.diagnostic.status, {
        error: {
          code: providerPlan.diagnostic.status,
          message: providerPlan.diagnostic.message,
          status: googleRpcStatusForHttpStatus(providerPlan.diagnostic.status),
        },
      });
    } else for (const provider of providerPlan.providers) {
      const resolved = await resolveModelForProvider(provider, model);
      if (!resolved) continue;

      sawModel = true;
      resolvedModelId = resolved.id;
      const binding = resolved.binding;
      const target = pickTarget(binding.upstreamModel.upstreamEndpoints);
      if (!target) continue;

      const attemptPayload = structuredClone(payload);
      const rewrittenContents = await rewriteStoredResponsesItemsForProvider(attemptPayload.contents ?? [], preparedStoredItems, binding, geminiViaResponsesItemsView);
      if (attemptPayload.contents !== undefined) attemptPayload.contents = rewrittenContents;

      // Gemini source payload has no `model` field on the request body; the
      // invocation carries the resolved id for telemetry/dispatch use.
      const responsesNewItems: StoredResponsesItem[] = [];
      const invocation: GeminiInvocation = geminiInvocation(binding, target, resolvedModelId, attemptPayload, responsesNewItems);

      const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>> = {
        messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
          await emitToMessages(geminiInvocation(binding, 'messages', resolvedModelId, tgtPayload, responsesNewItems), request)),
        responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) => {
          const targetInvocation: ResponsesInvocation = geminiInvocation(binding, 'responses', resolvedModelId, tgtPayload, responsesNewItems);
          const targetResult = await emitToResponses(targetInvocation, request);
          return targetResult.type === 'events'
            ? { ...targetResult, events: storeResponsesOutputItems(targetResult.events, targetInvocation, request) }
            : targetResult;
        }),
        'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
          await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload, responsesNewItems), request)),
      };

      result = await runInterceptors(invocation, request, [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])], () =>
        emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      break;
    }

    result ??= sawModel ? unsupportedGeminiModelResult(resolvedModelId) : missingGeminiModelResult(resolvedModelId);

    return await respondGemini(c, result, wantsStream, request, downstreamAbortController);
  } catch (error) {
    if (error instanceof StoredResponsesItemsDiagnosticError) {
      return Response.json(
        {
          error: {
            code: error.diagnostic.status,
            message: error.diagnostic.message,
            status: googleRpcStatusForHttpStatus(error.diagnostic.status),
          },
        },
        { status: error.diagnostic.status },
      );
    }
    return await respondGemini(
      c,
      sourceErrorResult(error, {
        sourceApi: 'gemini',
        internalStatus: 500,
      }),
      false,
      request, downstreamAbortController,
    );
  }
};
