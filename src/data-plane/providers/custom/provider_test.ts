import { test } from 'vitest';

import { createCustomProvider } from './provider.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertEquals } from '../../../test-assert.ts';
import { jsonResponse, withMockedFetch } from '../../../test-helpers.ts';

const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  enabledFixes: [],
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    supportedEndpoints: ['/chat/completions', '/responses', '/v1/messages', '/embeddings'],
  },
  ...overrides,
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'echo', object: 'model', supported_endpoints: ['/chat/completions', '/responses', '/v1/messages', '/v1/messages/count_tokens', '/embeddings'] }],
        });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/v1/chat/completions') {
        return jsonResponse({ id: 'cc', object: 'chat.completion', model: 'echo', choices: [], usage: {} });
      }
      if (path === '/v1/responses') {
        return jsonResponse({ id: 'r', object: 'response', model: 'echo', output: [], usage: {} });
      }
      if (path === '/v1/messages') {
        return jsonResponse({ id: 'm', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: 'end_turn', stop_sequence: null, usage: {} });
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/v1/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'echo' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      assertEquals(model.id, 'echo');

      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(model, { input: [] });
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(model, { input: 'hi' });
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
});
