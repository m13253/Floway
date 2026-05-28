import type { Context } from 'hono';

import { httpResponseToResponse, ProviderModelsUnavailableError } from '../../../../providers/models-store.ts';
import { listModelProviders, resolveModelForProvider } from '../../../../providers/registry.ts';
import { type MessagesInvocation, runInterceptors } from '../../../interceptors.ts';
import { toInternalDebugError } from '../../../shared/errors/internal-debug-error.ts';
import { createRequestContext } from '../../execute.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from '../../responses/items/request-plan.ts';
import { bodyAnthropicBetaResponse, bodyBetaParam, parseAnthropicBeta } from '../serve.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    const request = createRequestContext(c, undefined, false);
    const preparedStoredItems = await prepareStoredResponsesItemsForSource(payload.messages, request.apiKeyId ?? null, messagesViaResponsesItemsView);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) return Response.json(preparedDiagnostic.body, { status: preparedDiagnostic.status });
    let resp: Response | undefined;
    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), preparedStoredItems);
    if (providerPlan.type === 'error') return Response.json(providerPlan.diagnostic.body, { status: providerPlan.diagnostic.status });
    let resolvedModelId = payload.model;
    let sawModel = false;

    // count_tokens is non-streaming, so there is no downstream abort signal
    // and `clientStream` is false. The request context is still threaded
    // through `runInterceptors` so any future RequestContext-aware
    // count_tokens interceptor sees the same shape it would on the chat path.
    for (const provider of providerPlan.providers) {
      const resolved = await resolveModelForProvider(provider, payload.model);
      if (!resolved) continue;

      sawModel = true;
      resolvedModelId = resolved.id;
      const binding = resolved.binding;
      if (!binding.upstreamModel.upstreamEndpoints.includes('messages_count_tokens')) continue;

      const attemptPayload = structuredClone(payload);
      attemptPayload.model = resolvedModelId;
      attemptPayload.messages = await rewriteStoredResponsesItemsForProvider(attemptPayload.messages, preparedStoredItems, binding, messagesViaResponsesItemsView);
      // Build a MessagesInvocation matching the chat-planning shape so
      // provider-registered count_tokens interceptors (Copilot's vision,
      // initiator, anthropic-beta header workarounds) run against the same
      // payload, anthropic-beta, and header bag they would on /v1/messages.
      // targetApi is 'messages' because count_tokens hits the Messages
      // endpoint family; there is no separate count_tokens LlmTargetApi.
      const invocation: MessagesInvocation = {
        sourceApi: 'messages',
        targetApi: 'messages',
        model: resolvedModelId,
        upstream: binding.upstream,
        upstreamModel: binding.upstreamModel,
        provider: binding.provider,
        enabledFlags: binding.enabledFlags,
        ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
        responsesNewItems: [],
        payload: attemptPayload,
        headers: {},
        ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      };

      resp = await runInterceptors(invocation, request, invocation.targetInterceptors?.messagesCountTokens ?? [], async () => {
        const { model: _model, ...body } = invocation.payload;
        const { response } = await binding.provider.callMessagesCountTokens(invocation.upstreamModel, body, undefined, invocation.headers, invocation.anthropicBeta);
        return response;
      });
      break;
    }

    if (!resp) {
      const message = sawModel
        ? `Model ${resolvedModelId} does not support the /messages/count_tokens endpoint.`
        : `No upstream provides model ${resolvedModelId}. Configure an upstream that exposes this model in the dashboard.`;
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message,
          },
        },
        sawModel ? 400 : 404,
      );
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      const proxied = httpResponseToResponse(e.httpResponse);
      if (proxied) return proxied;
    }

    return c.json({ error: toInternalDebugError(e, 'messages') }, 502);
  }
};
