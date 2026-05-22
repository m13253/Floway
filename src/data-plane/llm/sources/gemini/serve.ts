import type { Context } from 'hono';

import { geminiSourceInterceptors } from './interceptors/index.ts';
import { respondGemini } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ModelEndpoint, ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { MessagesPayload } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type GeminiInterceptor, type GeminiInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateGeminiViaChatCompletions } from '../../translate/gemini-via-chat-completions/translate.ts';
import { translateGeminiViaMessages } from '../../translate/gemini-via-messages/translate.ts';
import { translateGeminiViaResponses } from '../../translate/gemini-via-responses/translate.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, jsonUpstreamErrorResult, sourceErrorResult } from '../execute.ts';

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

const geminiSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly GeminiInterceptor[] => [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])];

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
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
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

    const { id: modelId, model: resolved } = await resolveModelForRequest(model);
    let result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | undefined;

    if (!resolved) {
      result = missingGeminiModelResult(modelId);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const target = pickTarget(binding.upstreamModel.supportedEndpoints);
        if (!target) continue;

        // Gemini source payload has no `model` field on the request body; the
        // invocation carries the resolved id for telemetry/dispatch use.
        const invocation: GeminiInvocation = geminiInvocation(binding, target, modelId, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, GeminiStreamEvent>> = {
          messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(geminiInvocation(binding, 'messages', modelId, tgtPayload), request)),
          responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(geminiInvocation(binding, 'responses', modelId, tgtPayload), request)),
          'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', modelId, tgtPayload), request)),
        };

        result = await runInterceptors(invocation, request, geminiSourceInterceptorsForProvider(binding), () =>
          emits[target](invocation.payload, { model: modelId, wantsStream, capabilities }));
        break;
      }

      result ??= unsupportedGeminiModelResult(modelId);
    }

    return await respondGemini(c, result, wantsStream, request, downstreamAbortController);
  } catch (error) {
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
