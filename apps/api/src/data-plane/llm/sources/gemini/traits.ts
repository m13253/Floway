import { countGeminiTokens } from './count-tokens/serve.ts';
import { geminiSourceInterceptors } from './interceptors/index.ts';
import { respondGemini, geminiRpcErrorPayload, geminiRpcErrorResponse } from './respond.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type GeminiInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext } from '../request-context.ts';
import { jsonUpstreamErrorResult, sourceErrorResult, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiGenerateContentRequest, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses, viaTranslation } from '@floway-dev/translate';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const geminiErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, geminiRpcErrorPayload(status, message));

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

const renderGeminiFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<GeminiStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return geminiErrorResult(404, `Item with id '${failure.itemId}' not found.`);
  case 'routing-unavailable':
    return geminiErrorResult(400, failure.message);
  case 'model-missing':
    return geminiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return geminiErrorResult(400, `Model ${failure.model} does not support the Gemini generateContent endpoint.`);
  case 'internal':
    return sourceErrorResult<GeminiStreamEvent>(failure.error, { sourceApi: 'gemini', internalStatus: 500 });
  }
};

// The Gemini wire API encodes both the model and the action in one path
// segment, e.g. `models/gemini-2.5-pro:streamGenerateContent`. `setup` splits
// that here so the modelAction route maps straight onto `serveLlm(geminiTraits)`:
// `generateContent`/`streamGenerateContent` flow into the shared serve, while
// `countTokens` and unknown actions return their own Responses early.
export const geminiTraits: LlmSourceTraits<readonly GeminiContent[], GeminiStreamEvent> = {
  renderFailure: renderGeminiFailure,
  respond: async ({ c, result, request, wantsStream, downstreamAbortController }) =>
    await respondGemini(c, result, wantsStream, request, downstreamAbortController),
  setup: async c => {
    const modelAction = c.req.param('modelAction');
    if (!modelAction) return geminiRpcErrorResponse(404, 'Missing Gemini model action.');

    const separator = modelAction.lastIndexOf(':');
    if (separator <= 0 || separator === modelAction.length - 1) {
      return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
    }

    const model = modelAction.slice(0, separator).replace(/^models\//, '');
    const action = modelAction.slice(separator + 1);
    if (action === 'countTokens') return await countGeminiTokens(c, model);
    if (action !== 'generateContent' && action !== 'streamGenerateContent') {
      return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${action}`);
    }
    const wantsStream = action === 'streamGenerateContent';

    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);
    const payload = await c.req.json<GeminiGenerateContentRequest>();
    return {
      request,
      items: payload.contents ?? [],
      responsesItemsView: geminiViaResponsesItemsView,
      wantsStream,
      store: undefined,
      model,
      downstreamAbortController,
      pickTarget,
      attempt: async ({ binding, target, model: resolvedModelId, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        if (attemptPayload.contents !== undefined) attemptPayload.contents = await rewriteItems(attemptPayload.contents);
        // Gemini source payload has no `model` field on the request body; the
        // invocation carries the resolved id for telemetry/dispatch use.
        const invocation: GeminiInvocation = geminiInvocation(binding, target, resolvedModelId, attemptPayload);
        const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>> = {
          messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(geminiInvocation(binding, 'messages', resolvedModelId, tgtPayload), request)),
          responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(geminiInvocation(binding, 'responses', resolvedModelId, tgtPayload), request)),
          'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', resolvedModelId, tgtPayload), request)),
        };
        const interceptors = [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model: resolvedModelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};
