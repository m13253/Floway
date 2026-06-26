// Per-protocol alias preamble helpers. Each protocol's serve calls
// `resolveAndApply<Protocol>` immediately after parsing the inbound payload
// and before `enumerateProviderCandidates`. The helper:
//   1. looks up the inbound model name in the alias repo,
//   2. on a hit whose kind matches `chat`, picks one target row,
//   3. stamps the row's rules onto the IR (overwriting any matching field),
//   4. stages the `x-floway-alias` response header on the gateway ctx, and
//   5. returns the resolved target_model_id so the caller substitutes it
//      for `payload.model` before candidate enumeration runs.
//
// Returns `null` when the inbound name is not an alias of kind=chat;
// callers continue with the literal name and the catalog's miss surface
// renders if nothing matches. Throws `AliasNoTargetAvailableError` when
// the alias exists but every target is currently unroutable — caught at
// the serve seam and rendered via the protocol's failure renderer.

import { applyChatRulesToChatCompletions, applyChatRulesToGemini, applyChatRulesToMessages, applyChatRulesToResponses } from './apply.ts';
import { resolveAlias, type AliasResolution } from './resolve.ts';
import { getRepo } from '../../repo/index.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ChatAliasRules } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

const ALIAS_RESPONSE_HEADER = 'x-floway-alias';

// Common preamble: resolve the alias against the request's chat endpoint
// group and stage the response header. Returns the resolution (or null) so
// the caller can apply rules through its protocol's overlay helper. The
// chat-kind check lives inside the resolver — a kind mismatch silently
// returns null here.
const resolveChatAlias = async (modelName: string, ctx: GatewayCtx): Promise<AliasResolution | null> => {
  const resolution = await resolveAlias({
    modelName,
    endpointKind: 'chat',
    upstreamIds: ctx.upstreamIds,
    scheduler: ctx.backgroundScheduler,
    currentColo: ctx.currentColo,
    repo: getRepo().modelAliases,
  });
  if (resolution !== null) ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, resolution.aliasName);
  return resolution;
};

// All four `resolveAndApplyAliasFor*` helpers narrow the rule shape to
// `ChatAliasRules` before calling the per-protocol overlay. Today every
// chat-kind alias target carries `ChatAliasRules` per the wire schema; the
// cast is the unavoidable narrowing from the generic `AliasRules` union.
const asChatRules = (rules: AliasResolution['rules']): ChatAliasRules => rules as ChatAliasRules;

export const resolveAndApplyAliasForChatCompletions = async (payload: ChatCompletionsPayload, ctx: GatewayCtx): Promise<void> => {
  const resolution = await resolveChatAlias(payload.model, ctx);
  if (!resolution) return;
  payload.model = resolution.targetModelId;
  applyChatRulesToChatCompletions(payload, asChatRules(resolution.rules));
};

export const resolveAndApplyAliasForResponses = async (payload: ResponsesPayload, ctx: GatewayCtx): Promise<void> => {
  const resolution = await resolveChatAlias(payload.model, ctx);
  if (!resolution) return;
  payload.model = resolution.targetModelId;
  applyChatRulesToResponses(payload, asChatRules(resolution.rules));
};

export const resolveAndApplyAliasForMessages = async (payload: MessagesPayload, ctx: GatewayCtx): Promise<void> => {
  const resolution = await resolveChatAlias(payload.model, ctx);
  if (!resolution) return;
  payload.model = resolution.targetModelId;
  applyChatRulesToMessages(payload, asChatRules(resolution.rules));
};

// Gemini's model id is carried on the URL path, not the body — the caller
// passes it in alongside the payload and gets the resolved id back so it
// can substitute into the candidate-enumeration call. The payload is still
// mutated in place to overlay rules.
export const resolveAndApplyAliasForGemini = async (model: string, payload: GeminiPayload, ctx: GatewayCtx): Promise<string> => {
  const resolution = await resolveChatAlias(model, ctx);
  if (!resolution) return model;
  applyChatRulesToGemini(payload, asChatRules(resolution.rules));
  return resolution.targetModelId;
};

// Passthrough endpoints (embeddings, images) don't carry rules today; the
// resolver still runs to substitute the target id and stage the response
// header. Returns the resolved target_model_id (or the original name on
// miss). Throws `AliasNoTargetAvailableError` on the all-unroutable case
// like the chat helpers do.
export const resolveAliasForPassthrough = async (model: string, endpointKind: 'embedding' | 'image', ctx: GatewayCtx): Promise<string> => {
  const resolution = await resolveAlias({
    modelName: model,
    endpointKind,
    upstreamIds: ctx.upstreamIds,
    scheduler: ctx.backgroundScheduler,
    currentColo: ctx.currentColo,
    repo: getRepo().modelAliases,
  });
  if (resolution === null) return model;
  ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, resolution.aliasName);
  return resolution.targetModelId;
};
