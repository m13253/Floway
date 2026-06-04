import type { ModelProviderInstance, ProviderModelRecord } from './provider.ts';
import type { ExecuteResult } from './result.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesStreamEvent, ResponsesPayload } from '@floway-dev/protocols/responses';

export type LlmSourceApi = 'messages' | 'responses' | 'chat-completions' | 'gemini';
export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

// The provider-binding decision the planner made for this attempt: which
// upstream's binding to call and which target protocol to invoke on it.
// The binding carries the upstream identity, the upstream model record,
// the per-binding flag set, and the provider's interceptor table; `provider`
// is the resolved upstream provider instance the binding came from, retained
// alongside the binding so the call site can register telemetry, invalidate
// caches, and dispatch the upstream call without re-resolving the registry.
export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly binding: ProviderModelRecord;
  readonly targetApi: LlmTargetApi;
}

// Per-protocol invocation shape passed to interceptors. Carries the source-
// shape request body (mutable so source-side interceptors can clean it), the
// planner's binding decision, the original source protocol (so target-only
// interceptors can distinguish a native call from a translated one), and the
// mutable HTTP-header bag the source seeds empty. Target-portable interceptors
// populate `headers`; the provider's upstream call passes it through to the
// wire fetch unchanged, so workarounds that only need to set or drop a header
// (vision, initiator, anthropic-beta, ...) stay at the owning interceptor
// boundary instead of widening the provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  // `anthropicBeta` is an inbound Messages concept that crosses native
  // Messages targets; translated targets (Responses, Chat Completions) do not
  // consume it, so it stays optional and is only populated when the source
  // protocol is Messages and the target is Messages.
  readonly anthropicBeta?: readonly string[];
  readonly headers: Record<string, string>;
}

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  readonly headers: Record<string, string>;
}

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  readonly headers: Record<string, string>;
}

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  readonly headers: Record<string, string>;
}

// Provider-package interceptors do not read fields off the second argument
// (the per-request context); the api side supplies a richer object structurally
// satisfying this empty marker. Keeping the request slot parametric here also
// lets the api-side `*Interceptor` aliases choose their own request type
// (parameter contravariance: a function accepting `{}` accepts any concrete
// request).
export type InterceptorRequest = object;

export type ProviderMessagesInterceptor = Interceptor<MessagesInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>;
export type ProviderResponsesInterceptor = Interceptor<ResponsesInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
export type ProviderChatCompletionsInterceptor = Interceptor<ChatCompletionsInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>;
export type ProviderGeminiInterceptor = Interceptor<GeminiInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. Interceptors registered here MUST be pure
// header/payload mutators; post-`run()` result inspection is not portable to
// this result type.
export type ProviderMessagesCountTokensInterceptor = Interceptor<MessagesInvocation, InterceptorRequest, Response>;

// Gemini count_tokens reshapes its upstream into a `PlainResult` rather than
// the raw Response that Messages count_tokens returns. Interceptors share the
// same payload-mutator contract — no post-`run()` event-stream inspection.
export type ProviderGeminiCountTokensInterceptor = Interceptor<GeminiInvocation, InterceptorRequest, import('./result.ts').PlainResult>;
