import { test } from 'vitest';

import { createAzureProvider } from './provider.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertEquals } from '../../../test-assert.ts';
import { withMockedFetch } from '../../../test-helpers.ts';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    deployments: [
      {
        deployment: 'gpt-prod',
        publicModelId: 'gpt-public',
        supportedEndpoints: ['/chat/completions', '/responses', '/embeddings'],
        display_name: 'GPT Public',
        capabilities: {
          limits: { max_context_window_tokens: 128000 },
          supports: { streaming: true },
        },
      },
      {
        deployment: 'gpt-small',
        publicModelId: ' ',
        supportedEndpoints: ['/chat/completions'],
      },
    ],
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_azure',
    provider: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    enabledFixes: [],
    ...rest,
    config: overrideConfig ?? config,
  };
};

test('createAzureProvider projects configured deployments into upstream models', async () => {
  const instance = createAzureProvider(azureRecord({ enabledFixes: ['deepseek-reasoning-dialect'] }));
  const models = await instance.provider.getProvidedModels();

  assertEquals(instance.upstream, 'up_azure');
  assertEquals(instance.name, 'Azure Resource');
  assertEquals(instance.enabledFixes.has('deepseek-reasoning-dialect'), true);
  assertEquals(
    models.map(model => ({ id: model.id, name: model.name, displayName: model.display_name, endpoints: model.supportedEndpoints, providerData: model.providerData })),
    [
      {
        id: 'gpt-public',
        name: 'gpt-public',
        displayName: 'GPT Public',
        endpoints: ['chat_completions', 'responses', 'embeddings'],
        providerData: { deployment: 'gpt-prod' },
      },
      {
        id: 'gpt-small',
        name: 'gpt-small',
        displayName: undefined,
        endpoints: ['chat_completions'],
        providerData: { deployment: 'gpt-small' },
      },
    ],
  );
  assertEquals(models[0].capabilities.limits.max_context_window_tokens, 128000);
  assertEquals(models[0].capabilities.supports.streaming, true);
});

test('createAzureProvider sends deployment names in OpenAI-shaped request bodies and model keys', async () => {
  const instance = createAzureProvider(azureRecord());
  const [model] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const chat = await instance.provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hello' }] });
      const responses = await instance.provider.callResponses(model, { input: 'hello' });
      const embeddings = await instance.provider.callEmbeddings(model, { input: 'hello' });

      assertEquals(chat.modelKey, 'gpt-prod');
      assertEquals(responses.modelKey, 'gpt-prod');
      assertEquals(embeddings.modelKey, 'gpt-prod');
    },
  );

  assertEquals(
    seen.map(item => item.url),
    [
      'https://example.openai.azure.com/openai/v1/chat/completions',
      'https://example.openai.azure.com/openai/v1/responses',
      'https://example.openai.azure.com/openai/v1/embeddings',
    ],
  );
  assertEquals(
    seen.map(item => item.body.model),
    ['gpt-prod', 'gpt-prod', 'gpt-prod'],
  );
});

test('createAzureProvider supports Azure AI cross-provider deployments with explicit endpoint capabilities', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'deepseek-v4-pro',
            supportedEndpoints: ['/chat/completions'],
          },
          {
            deployment: 'gpt-5.4-pro',
            publicModelId: '',
            supportedEndpoints: ['/responses'],
          },
        ],
      },
    }),
  );
  const [chatModel, responsesModel] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];

  assertEquals(chatModel.id, 'deepseek-v4-pro');
  assertEquals(chatModel.supportedEndpoints, ['chat_completions']);
  assertEquals(responsesModel.id, 'gpt-5.4-pro');
  assertEquals(responsesModel.supportedEndpoints, ['responses']);

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const chat = await instance.provider.callChatCompletions(chatModel, { messages: [{ role: 'user', content: 'hello' }] });
      const responses = await instance.provider.callResponses(responsesModel, { input: 'hello' });
      assertEquals(chat.modelKey, 'deepseek-v4-pro');
      assertEquals(responses.modelKey, 'gpt-5.4-pro');
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.openai.azure.com/openai/v1/chat/completions',
      apiKey: 'az-key',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        model: 'deepseek-v4-pro',
      },
    },
    {
      url: 'https://example.openai.azure.com/openai/v1/responses',
      apiKey: 'az-key',
      body: {
        input: 'hello',
        stream: true,
        model: 'gpt-5.4-pro',
      },
    },
  ]);
});

test('createAzureProvider supports native Azure Anthropic Messages deployments', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.services.ai.azure.com/anthropic/v1',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'claude-prod',
            publicModelId: 'claude-public',
            supportedEndpoints: ['/v1/messages'],
          },
        ],
      },
    }),
  );
  const [model] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; xApiKey: string | null; body: Record<string, unknown>; beta: string | null }> = [];

  assertEquals(model.id, 'claude-public');
  assertEquals(model.supportedEndpoints, ['messages', 'messages_count_tokens']);

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        xApiKey: request.headers.get('x-api-key'),
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get('anthropic-beta'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const messages = await instance.provider.callMessages(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, ['context-1m']);
      const count = await instance.provider.callMessagesCountTokens(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] });
      assertEquals(messages.modelKey, 'claude-prod');
      assertEquals(count.modelKey, 'claude-prod');
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      xApiKey: 'az-key',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], stream: true, model: 'claude-prod' },
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      xApiKey: 'az-key',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'claude-prod' },
      beta: null,
    },
  ]);
});
