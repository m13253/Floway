import type { Context } from 'hono';

import { responsesSourceInterceptors } from './interceptors/index.ts';
import { storeResponsesOutputItems } from './items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from './items/request-plan.ts';
import { respondResponses } from './respond.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { listModelProviders, resolveModelForProvider } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateResponsesViaChatCompletions, translateResponsesViaMessages, viaTranslation } from '@floway-dev/translate';
import { responsesItemsSource } from '@floway-dev/translate/via-responses/responses-items';

const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';

// previous_response_id relies on server-side conversation state that this
// gateway does not implement. Stored Responses item ids are handled below; a
// plain previous response pointer still gets OpenAI's not-found contract so
// clients that retry with full input can keep using their existing fallback.
// Verbatim payloads cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
const previousResponseNotFoundResponse = (payload: ResponsesPayload): Response | undefined => {
  if (payload.previous_response_id !== undefined && payload.previous_response_id !== null) {
    return Response.json(
      {
        error: {
          message: `Previous response with id '${payload.previous_response_id}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      },
      { status: 400 },
    );
  }
  return undefined;
};

const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;

  // TODO: Replace this source-entry hardcode with generic model alias support.
  // Codex sends auto-review requests over the Responses wire API, so rewriting
  // here keeps downstream routing, performance telemetry, and usage accounting
  // on the real model name.
  // References:
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/model-provider/src/provider.rs#L73-L96
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/codex-api/src/endpoint/responses.rs#L102-L134
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

const responsesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
  responsesNewItems: StoredResponsesItem[],
) => ({
  sourceApi: 'responses' as const,
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

export const serveResponses = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('responses')) return 'responses';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    return null;
  };

  try {
    const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>());
    const notFound = previousResponseNotFoundResponse(payload);
    if (notFound) return notFound;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const preparedStoredItems = await prepareStoredResponsesItemsForSource(payload.input, request.apiKeyId ?? null, responsesItemsSource);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) return Response.json(preparedDiagnostic.body, { status: preparedDiagnostic.status });

    let result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | undefined;
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
      attemptPayload.input = await rewriteStoredResponsesItemsForProvider(attemptPayload.input, preparedStoredItems, binding, responsesItemsSource);

      const responsesNewItems: StoredResponsesItem[] = [];
      const invocation: ResponsesInvocation = responsesInvocation(binding, target, resolvedModelId, attemptPayload, responsesNewItems);

      const emits: Record<LlmTargetApi, SourceEmit<ResponsesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>> = {
        responses: async srcPayload => await emitToResponses({ ...invocation, payload: srcPayload }, request),
        messages: viaTranslation(translateResponsesViaMessages, async (tgtPayload: MessagesPayload) =>
          await emitToMessages(responsesInvocation(binding, 'messages', resolvedModelId, tgtPayload, responsesNewItems), request)),
        'chat-completions': viaTranslation(translateResponsesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
          await emitToChatCompletions(responsesInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload, responsesNewItems), request)),
      };

      const rawResult = await runInterceptors(invocation, request, [...responsesSourceInterceptors, ...(binding.sourceInterceptors?.responses ?? [])], () =>
        emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      result = rawResult.type === 'events'
        ? { ...rawResult, events: storeResponsesOutputItems(rawResult.events, invocation, request) }
        : rawResult;
      break;
    }

    result ??= sawModel ? openAiUnsupportedEndpointResult(resolvedModelId, '/responses') : openAiMissingModelResult(resolvedModelId);

    return await respondResponses(c, result, wantsStream, request, downstreamAbortController);
  } catch (error) {
    return await respondResponses(
      c,
      sourceErrorResult(error, {
        sourceApi: 'responses',
        internalStatus: 502,
      }),
      false,
      request, downstreamAbortController,
    );
  }
};
