import { describe, test } from 'vitest';

import { planChatCandidates } from './candidates.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-helpers.ts';
import { enumerateProviderCandidates } from '../../providers/candidates.ts';
import { clearInFlightForTesting } from '../../providers/models-cache.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// Drains SWR background revalidate so a rejection surfaces in the runner
// instead of being swallowed.
const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

// Azure resolves its catalog without HTTP, giving deterministic candidates.
const azureUpstream = (id: string, sortOrder: number, modelIds: string[], endpoints: ModelEndpoints): UpstreamRecord => ({
  id,
  provider: 'azure',
  name: id,
  enabled: true,
  sortOrder,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    endpoint: `https://${id}.openai.azure.com`,
    apiKey: 'az-key',
    models: modelIds.map(upstreamModelId => ({ upstreamModelId, endpoints })),
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

const pickMessages = (e: ModelEndpoints): ChatTargetApi | null =>
  e.messages ? 'messages' : null;

const pickMessagesOrResponses = (e: ModelEndpoints): ChatTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : null;

const pickResponses = (e: ModelEndpoints): ChatTargetApi | null =>
  e.responses ? 'responses' : null;

const pickAny = (e: ModelEndpoints): ChatTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : e.chatCompletions ? 'chat-completions' : null;

describe('enumerateProviderCandidates', () => {
  test('single provider with a matching binding yields one candidate', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_a');
    assertEquals(candidates[0].model.id, 'test-model');
    assertEquals(sawModel, true);
  });

  test('provider yields a candidate regardless of endpoint shape', async () => {
    // Resolution is kind-aware and endpoint-blind: a chat-kind model with
    // only `chatCompletions` set is a candidate at this layer. Whether the
    // serve's preference table accepts it is the planner's job.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_chat');
    assertEquals(sawModel, true);
  });

  test('provider without a binding for the requested model yields no candidate and sawModel=false', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['other-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 0);
    assertEquals(sawModel, false);
  });

  test('multiple providers: only those with the model produce candidates in sort_order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_first', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_second', 20, ['other-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_third', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_first');
    assertEquals(candidates[1].provider.upstream, 'up_third');
  });

  test('upstreamIds filtering: only matching providers surface in given order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_b', 20, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_c', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: ['up_c', 'up_a'],
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_c');
    assertEquals(candidates[1].provider.upstream, 'up_a');
  });

  test('upstreamIds=null returns all enabled providers', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_enabled', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save({
      ...azureUpstream('up_disabled', 20, ['test-model'], { messages: {} }),
      enabled: false,
    });

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_enabled');
  });

  // Regression: a single upstream whose catalog fetch rejects must not poison
  // the loop. The healthy upstreams still produce candidates and the broken
  // upstream's display name surfaces via failedUpstreams so the eventual
  // serve-side error renderer can mention it.
  test('a single rejecting upstream does not block candidates from healthy upstreams', async () => {
    clearInFlightForTesting();
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_broken',
      name: 'Broken upstream',
      sortOrder: 1,
      config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { messages: {} } },
    }));
    await repo.upstreams.save(azureUpstream('up_ok', 2, ['test-model'], { messages: {} }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ error: 'upstream went down' }, 502);
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
          upstreamIds: null,
          model: 'test-model',
          kind: 'chat',
          scheduler: testScheduler,
          currentColo: 'TEST',
        });

        assertEquals(candidates.length, 1);
        assertEquals(candidates[0].provider.upstream, 'up_ok');
        assertEquals(sawModel, true);
        assertEquals(failedUpstreams, ['Broken upstream']);
      },
    );
  });

  // When every upstream's catalog rejects, the request gets an empty candidate
  // list and sawModel=false — the chat serve sites turn that into model-missing
  // with the failed-upstream parenthetical attached.
  test('all upstreams rejecting yields no candidates, sawModel=false, and every name in failedUpstreams', async () => {
    clearInFlightForTesting();
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_a',
      name: 'A',
      sortOrder: 1,
      config: { baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { messages: {} } },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_b',
      name: 'B',
      sortOrder: 2,
      config: { baseUrl: 'https://b.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { messages: {} } },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/models') return jsonResponse({ error: 'down' }, 502);
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
          upstreamIds: null,
          model: 'test-model',
          kind: 'chat',
          scheduler: testScheduler,
          currentColo: 'TEST',
        });

        assertEquals(candidates.length, 0);
        assertEquals(sawModel, false);
        assertEquals(failedUpstreams, ['A', 'B']);
      },
    );
  });
});

describe('planChatCandidates', () => {
  // The picker callback runs at the serve layer, after resolution: it maps
  // each candidate's `model.endpoints` to a target protocol via the
  // inbound-protocol preference table. Candidates whose picker returns null
  // drop out before the planner sees them.
  test('multi-endpoint candidate picks the picker-preferred target', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_multi', 10, ['test-model'], { messages: {}, responses: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    const messagesItems = planChatCandidates(candidates, pickMessagesOrResponses);
    assertEquals(messagesItems.length, 1);
    assertEquals(messagesItems[0].targetApi, 'messages');

    const responsesItems = planChatCandidates(candidates, pickResponses);
    assertEquals(responsesItems.length, 1);
    assertEquals(responsesItems[0].targetApi, 'responses');
  });

  test('picker returning null drops the candidate', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    const anyItems = planChatCandidates(candidates, pickAny);
    assertEquals(anyItems.length, 1);
    assertEquals(anyItems[0].targetApi, 'chat-completions');

    const messagesItems = planChatCandidates(candidates, pickMessages);
    assertEquals(messagesItems.length, 0);
  });
});
