import type { Context } from 'hono';

import { messagesSourceInterceptors } from './interceptors/index.ts';
import { respondMessages } from './respond.ts';
import { listModelProviders, resolveModelForProvider } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type MessagesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import { StoredResponsesItemsDiagnosticError } from '../responses/items/errors.ts';
import { noopResponsesItemsCommit, type ResponsesItemsCommit, storeResponsesOutputItems } from '../responses/items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from '../responses/items/request-plan.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';
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

export const serveMessages = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    return null;
  };

  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    const preparedStoredItems = await prepareStoredResponsesItemsForSource(payload.messages, request.apiKeyId ?? null, messagesViaResponsesItemsView);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) return Response.json(preparedDiagnostic.body, { status: preparedDiagnostic.status });

    let result: ExecuteResult<ProtocolFrame<MessagesStreamEventData>> | undefined;
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
      attemptPayload.messages = await rewriteStoredResponsesItemsForProvider(attemptPayload.messages, preparedStoredItems, binding, messagesViaResponsesItemsView);

      const sharedHeaders: Record<string, string> = {};
      const invocation: MessagesInvocation = messagesInvocation(binding, target, resolvedModelId, attemptPayload, anthropicBeta, sharedHeaders);

      const emits: Record<LlmTargetApi, SourceEmit<MessagesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<MessagesStreamEventData>>>> = {
        messages: async srcPayload => await emitToMessages({ ...invocation, payload: srcPayload }, request),
        responses: viaTranslation(translateMessagesViaResponses, async (tgtPayload: ResponsesPayload) =>
          await emitToResponses(messagesInvocation(binding, 'responses', resolvedModelId, tgtPayload, undefined, sharedHeaders), request)),
        'chat-completions': viaTranslation(translateMessagesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
          await emitToChatCompletions(messagesInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload, undefined, sharedHeaders), request)),
      };

      const rawResult = await runInterceptors(invocation, request, [...messagesSourceInterceptors, ...(binding.sourceInterceptors?.messages ?? [])], () =>
        emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      if (rawResult.type === 'events') {
        const stored = storeResponsesOutputItems(rawResult.events, messagesViaResponsesItemsView, { targetApi: invocation.targetApi, upstream: invocation.upstream, store: undefined }, request, wantsStream);
        result = { ...rawResult, events: stored.events };
        commitStoredItems = stored.commit;
      } else {
        result = rawResult;
      }
      break;
    }

    result ??= sawModel ? openAiUnsupportedEndpointResult(resolvedModelId, '/messages') : openAiMissingModelResult(resolvedModelId);

    return await respondMessages(c, result, wantsStream, request, downstreamAbortController, commitStoredItems);
  } catch (error) {
    if (error instanceof StoredResponsesItemsDiagnosticError) {
      return Response.json(error.diagnostic.body, { status: error.diagnostic.status });
    }
    return await respondMessages(
      c,
      sourceErrorResult(error, {
        sourceApi: 'messages',
        internalStatus: 502,
      }),
      false,
      request, downstreamAbortController,
      noopResponsesItemsCommit,
    );
  }
};
