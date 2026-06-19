import { ensureClaudeCodeAccessToken } from './access-token-cache.ts';
import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { detectHaikuProbe, callClaudeCodeMessages } from './fetch.ts';
import { claudeCodeMessagesChain, type ClaudeCodeMessagesBoundaryCtx } from './interceptors/messages/index.ts';
import { buildClaudeCodeCatalog, claudeCodeResolveRequestedModelId, fetchClaudeCodeModelsList } from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import {
  defaultsForProvider,
  getProviderRepo,
  resolveEffectiveFlags,
  type ModelProvider,
  type ModelProviderInstance,
  type ProviderCallResult,
  type ProviderCompactionResult,
  type ProviderStreamResult,
  type UpstreamCallOptions,
  type UpstreamRecord,
} from '@floway-dev/provider';

export const createClaudeCodeProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);

  const enabledFlags = resolveEffectiveFlags(defaultsForProvider('claude-code'), [record.flagOverrides]);

  const provider: ModelProvider = {
    // Catalog refresh mints an access token and hits /v1/models on every
    // dispatcher poll. `ensureClaudeCodeAccessToken` flips the row to
    // `refresh_failed` and throws `ClaudeCodeOAuthSessionTerminatedError`
    // when the refresh_token has died; we rethrow so the catalog cache
    // records the failure and surfaces it on the dashboard exactly as
    // codex does.
    getProvidedModels: async fetcher => {
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getProviderRepo().upstreams,
        fetcher,
      });
      const apiModels = await fetchClaudeCodeModelsList(access.entry.token, fetcher);
      return buildClaudeCodeCatalog(apiModels, enabledFlags);
    },

    getPricingForModelKey: pricingForClaudeCodeModelKey,

    callMessages: async (model, body, signal, _headers, _anthropicBeta, opts) => {
      const ctx: ClaudeCodeMessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
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
        // Drop `model` from the payload: callClaudeCodeMessages re-attaches the
        // dated upstream id (from `opts.model.providerData.upstreamModelId`)
        // on the wire so Anthropic sees a stable per-revision id rather than
        // the public alias the catalog exposes to clients.
        const { model: _ignored, ...wireBody } = ctx.payload;
        return await callClaudeCodeMessages({
          upstreamId: record.id,
          model,
          body: wireBody,
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

    // Claude Code only exposes /v1/messages; getProvidedModels advertises
    // that single endpoint and no other entry point is reachable in
    // practice. A stray dispatch from a routing bug must still produce a
    // proper 405 with a JSON error envelope rather than letting a raw
    // stack trace bubble up the boundary. The synthetic response still
    // flows through the per-call latency recorder so the gateway's
    // wrap-once contract holds even for these stubs.
    callMessagesCountTokens: (_model, _body, _signal, _headers, _beta, opts) => unsupportedCallResult(opts),
    callChatCompletions: (_model, _body, _signal, _headers, opts) => unsupportedStreamResult(opts),
    callResponses: (_model, _body, _signal, _headers, opts) => unsupportedStreamResult(opts),
    callResponsesCompact: (_model, _body, _signal, _headers, opts) => unsupportedCompactionResult(opts),
    callEmbeddings: (_model, _body, _signal, _headers, opts) => unsupportedCallResult(opts),
    callImagesGenerations: (_model, _body, _signal, _headers, opts) => unsupportedCallResult(opts),
    callImagesEdits: (_model, _body, _signal, _headers, opts) => unsupportedCallResult(opts),
  };

  return {
    upstream: record.id,
    providerKind: 'claude-code',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: false,
    resolveRequestedModelId: claudeCodeResolveRequestedModelId,
  };
};

// Claude Code advertises only /v1/messages; a request that somehow reaches
// one of the other surfaces is a routing bug, not user input. Return a
// synthetic 405 (carrying the same JSON error envelope shape the rest of
// the gateway uses) so the boundary can relay it verbatim instead of
// leaking a raw stack trace. The response still flows through
// `recordUpstreamLatency` to honour the wrap-once contract — every code
// path that produces a boundary-facing response must invoke the recorder
// exactly once, even when the response is synthesized without ever
// hitting the network.
const synthetic405 = (): Response => new Response(
  JSON.stringify({ error: { type: 'method_not_allowed', message: 'Endpoint not supported by claude-code provider' } }),
  { status: 405, headers: { 'content-type': 'application/json' } },
);

const unsupportedStreamResult = async <TEvent>(opts: UpstreamCallOptions): Promise<ProviderStreamResult<TEvent>> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});

const unsupportedCallResult = async (opts: UpstreamCallOptions): Promise<ProviderCallResult> => ({
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});

const unsupportedCompactionResult = async (opts: UpstreamCallOptions): Promise<ProviderCompactionResult> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});
