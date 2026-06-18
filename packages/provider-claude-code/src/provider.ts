import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { detectHaikuProbe, callClaudeCodeMessages } from './fetch.ts';
import { claudeCodeMessagesChain, type ClaudeCodeMessagesBoundaryCtx } from './interceptors/messages/index.ts';
import { buildClaudeCodeModels } from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import {
  defaultsForProvider,
  resolveEffectiveFlags,
  type ModelProvider,
  type ModelProviderInstance,
  type ProviderStreamResult,
  type UpstreamRecord,
} from '@floway-dev/provider';

export const createClaudeCodeProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);
  // The account identity is read live on every request by callClaudeCodeMessages
  // (re-reading state through the provider repo); the factory just confirms the
  // record validates and hands control to the per-call helpers. Future N-account
  // fan-out will pick an account at the call site.

  // Computed once per provider instance: only the upstream layer applies
  // (no per-model override layer).
  const enabledFlags = resolveEffectiveFlags(defaultsForProvider('claude-code'), [record.flagOverrides]);
  const models = buildClaudeCodeModels(enabledFlags);

  const provider: ModelProvider = {
    getProvidedModels: async () => models,

    getPricingForModelKey: pricingForClaudeCodeModelKey,

    callMessages: async (model, body, signal, headers, _anthropicBeta, opts) => {
      const ctx: ClaudeCodeMessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...headers },
        model,
        upstreamId: record.id,
      };

      // Detection runs on the inbound, unmodified payload + client headers.
      // The re-mimicry chain would clobber operator-supplied `system` content
      // and overwrite the wire shape — exactly what a CC-shaped passthrough
      // needs to preserve. So the chain only runs on the unshaped path; the
      // shaped path skips straight to the terminal call, which forwards the
      // caller's headers and body byte-for-byte (Authorization swap only).
      //
      // `clientRequestHeaders` / `clientRequestPathname` carry the inbound
      // HTTP request's identity (UA, anthropic-version, x-app, pathname).
      // When the gateway is invoked outside a real Hono request (synthetic
      // tests, translation chains that never originated as /v1/messages),
      // both fields are undefined and detection downgrades to "not shaped".
      const looksShaped = opts.clientRequestHeaders !== undefined
        && opts.clientRequestPathname !== undefined
        && isClaudeCodeShapedRequest({
          headers: new Headers(opts.clientRequestHeaders),
          pathname: opts.clientRequestPathname,
          body: ctx.payload,
          isMaxTokensOneHaikuProbe: detectHaikuProbe(ctx.payload),
        });

      const terminal = async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
        const { model: _ignored, ...wireBody } = ctx.payload;
        return await callClaudeCodeMessages({
          upstreamId: record.id,
          model,
          body: wireBody,
          headers: ctx.headers,
          shaped: looksShaped,
          signal,
          call: opts,
        });
      };

      if (looksShaped) return await terminal();

      return await runInterceptors<ClaudeCodeMessagesBoundaryCtx, object, ProviderStreamResult<MessagesStreamEvent>>(
        ctx,
        {},
        claudeCodeMessagesChain<ProviderStreamResult<MessagesStreamEvent>>(),
        terminal,
      );
    },

    // The Claude Code subscription endpoint exposes /v1/messages only.
    // getProvidedModels advertises that single endpoint, so no other entry
    // point should ever route here — the stubs document intent and fail
    // loud if dispatch ever changes.
    callMessagesCountTokens: () => Promise.reject(new Error('Claude Code provider does not implement callMessagesCountTokens')),
    callChatCompletions: () => Promise.reject(new Error('Claude Code provider does not implement callChatCompletions')),
    callResponses: () => Promise.reject(new Error('Claude Code provider does not implement callResponses')),
    callResponsesCompact: () => Promise.reject(new Error('Claude Code provider does not implement callResponsesCompact')),
    callEmbeddings: () => Promise.reject(new Error('Claude Code provider does not implement callEmbeddings')),
    callImagesGenerations: () => Promise.reject(new Error('Claude Code provider does not implement callImagesGenerations')),
    callImagesEdits: () => Promise.reject(new Error('Claude Code provider does not implement callImagesEdits')),
  };

  return {
    upstream: record.id,
    providerKind: 'claude-code',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: false,
  };
};
