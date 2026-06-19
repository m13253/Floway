import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildClaudeCodeModels } from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ClaudeCodeAccessTokenEntry, ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from './state.ts';
import { initProviderRepo, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

const upstreamId = 'up_cc_provider';
const upstreamModel = buildClaudeCodeModels(new Set<string>())[0]!;

const activeAccount: ClaudeCodeAccountCredential = {
  accountUuid: 'acc-1',
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: {
    token: 'at_cached',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    refreshedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  } as ClaudeCodeAccessTokenEntry,
  quotaSnapshot: null,
};

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'claude-code',
  name: 'CC',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max_5x' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as ClaudeCodeUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      c.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

const cliClientCallOpts = (overrides: Partial<UpstreamCallOptions> = {}): UpstreamCallOptions => ({
  ...noopUpstreamCallOptions,
  clientRequestHeaders: {
    'user-agent': 'claude-cli/2.1.181 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  },
  clientRequestPathname: '/v1/messages',
  ...overrides,
});

describe('createClaudeCodeProvider — factory surface', () => {
  test('getProvidedModels returns the three-model catalog under public aliases', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const models = await instance.provider.getProvidedModels(noopUpstreamCallOptions.fetcher);
    expect(models.map(m => m.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  test('getProvidedModels stamps the effective flag set onto every model', async () => {
    // strip-billing-attribution defaults OFF for claude-code, and there are
    // no upstream overrides on the record — the effective set must be empty,
    // not the copilot/azure/custom default.
    const instance = await createClaudeCodeProvider(currentRecord);
    const models = await instance.provider.getProvidedModels(noopUpstreamCallOptions.fetcher);
    for (const m of models) {
      expect(m.enabledFlags.has('strip-billing-attribution')).toBe(false);
    }
  });

  test('getPricingForModelKey wires through the pricing table (keyed by dated upstream id)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    expect(instance.provider.getPricingForModelKey('claude-sonnet-4-5-20250929'))
      .toEqual(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'));
    expect(instance.provider.getPricingForModelKey('unknown-id')).toBeNull();
  });

  test('providerKind is "claude-code" and supportsResponsesItemReference is false', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    expect(instance.providerKind).toBe('claude-code');
    expect(instance.supportsResponsesItemReference).toBe(false);
    expect(instance.upstream).toBe(upstreamId);
  });

  test('resolveRequestedModelId maps a dated id to its alias', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    expect(instance.resolveRequestedModelId?.('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(instance.resolveRequestedModelId?.('claude-sonnet-4-5')).toBeUndefined();
  });

  test('every unsupported surface returns a synthetic 405 envelope (no stack-trace leak)', async () => {
    // Claude Code advertises only /v1/messages; any other surface is a
    // routing bug. Surface a clean 405 rather than a raw rejection so the
    // boundary can relay verbatim.
    const instance = await createClaudeCodeProvider(currentRecord);
    const body = { messages: [] as never[] };

    const assertSynthetic405 = async (response: Response): Promise<void> => {
      expect(response.status).toBe(405);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      const json = await response.json() as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe('method_not_allowed');
      expect(json.error?.message).toMatch(/claude-code/);
    };

    const chat = await instance.provider.callChatCompletions(upstreamModel, body, undefined, undefined, noopUpstreamCallOptions);
    expect(chat.ok).toBe(false);
    if (!chat.ok) await assertSynthetic405(chat.response);

    const responses = await instance.provider.callResponses(upstreamModel, { input: 'x' }, undefined, undefined, noopUpstreamCallOptions);
    expect(responses.ok).toBe(false);
    if (!responses.ok) await assertSynthetic405(responses.response);

    const compact = await instance.provider.callResponsesCompact(upstreamModel, { input: 'x' }, undefined, undefined, noopUpstreamCallOptions);
    expect(compact.ok).toBe(false);
    if (!compact.ok) await assertSynthetic405(compact.response);

    const countTokens = await instance.provider.callMessagesCountTokens(upstreamModel, { max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, undefined, undefined, undefined, noopUpstreamCallOptions);
    await assertSynthetic405(countTokens.response);

    const embeddings = await instance.provider.callEmbeddings(upstreamModel, { input: 'x' }, undefined, undefined, noopUpstreamCallOptions);
    await assertSynthetic405(embeddings.response);

    const imagesGen = await instance.provider.callImagesGenerations(upstreamModel, { prompt: 'x' }, undefined, undefined, noopUpstreamCallOptions);
    await assertSynthetic405(imagesGen.response);

    const imagesEdit = await instance.provider.callImagesEdits(upstreamModel, new FormData(), undefined, undefined, noopUpstreamCallOptions);
    await assertSynthetic405(imagesEdit.response);
  });
});

describe('createClaudeCodeProvider — callMessages routes through chain', () => {
  test('unshaped request runs the re-mimicry chain (3-block system, pinned UA, metadata.user_id)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    await instance.provider.callMessages(
      upstreamModel,
      { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      undefined,
      {},
      undefined,
      noopUpstreamCallOptions,
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('user-agent')).toMatch(/^claude-cli\//);
    expect(wireHeaders.get('anthropic-beta')).toBeTruthy();

    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(3);
    expect(body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(body.system[1].text).toMatch(/^You are Claude Code/);
    expect(body.system[2].cache_control).toEqual({ type: 'ephemeral' });
    expect(typeof body.metadata.user_id).toBe('string');
    expect(body.metadata.user_id.startsWith('{')).toBe(true);
  });

  test('shaped request (CC fingerprint on clientRequestHeaders) preserves caller-supplied system + headers (chain skipped)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    const userId = JSON.stringify({ device_id: 'd'.repeat(32), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    await instance.provider.callMessages(
      upstreamModel,
      {
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        metadata: { user_id: userId },
      },
      undefined,
      {},
      undefined,
      cliClientCallOpts(),
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // System stays as the operator sent it — the chain did NOT mutate to
    // the 3-block re-mimicry shape.
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toMatch(/^You are Claude Code/);
    // metadata.user_id stays verbatim.
    expect(body.metadata.user_id).toBe(userId);
  });

  test('CC UA but missing clientRequestPathname still runs the chain', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    await instance.provider.callMessages(
      upstreamModel,
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      {},
      undefined,
      { ...noopUpstreamCallOptions, clientRequestHeaders: { 'user-agent': 'claude-cli/2.1.181' } },
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // Re-mimicry ran: system was rebuilt into the 3-block shape.
    expect(body.system).toHaveLength(3);
  });
});
