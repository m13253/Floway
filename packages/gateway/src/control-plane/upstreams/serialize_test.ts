import { expect, test } from 'vitest';

import { upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const timestamp = '2026-04-29T00:00:00.000Z';

const custom: UpstreamRecord = {
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Upstream',
  enabled: true,
  sortOrder: 10,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: { 'vendor-deepseek': true },
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  config: {
    baseUrl: 'https://api.example.com',
    bearerToken: 'sk-secret-token-12345',
    endpoints: { chatCompletions: {}, responses: {} },
    modelsFetch: { enabled: true, endpoint: '/models' },
    models: [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }],
  },
  state: null,
};

test('upstreamRecordToJson redacts custom bearer token inside config', () => {
  const result = upstreamRecordToJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(result.provider, 'custom');
  assertEquals(result.sort_order, 10);
  assertEquals(result.created_at, timestamp);
  assertEquals(result.updated_at, timestamp);
  assertEquals(result.flag_overrides, { 'vendor-deepseek': true });
  assertEquals(result.state, null);
  assertEquals(config.baseUrl, 'https://api.example.com');
  assertEquals(config.bearerToken, undefined);
  assertEquals(config.bearerTokenSet, true);
  assertEquals(config.endpoints, { chatCompletions: {}, responses: {} });
  assertEquals(config.modelsFetch, { enabled: true, endpoint: '/models' });
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }]);
});

test('upstreamRecordToJson redacts Azure API keys inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_azure_test',
    provider: 'azure',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }],
    },
  });
  const config = result.config as Record<string, unknown>;

  assertEquals(result.provider, 'azure');
  assertEquals(config.endpoint, 'https://example.openai.azure.com');
  assertEquals(config.apiKey, undefined);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }]);
});

test('upstreamRecordToJson redacts Copilot GitHub token inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_test',
    provider: 'copilot',
    config: {
      githubToken: 'ghu_secret',
      accountType: 'individual',
      user: {
        id: 100,
        login: 'octo',
        name: null,
        avatar_url: 'https://example.com/avatar.png',
      },
    },
  });
  const config = result.config as Record<string, unknown>;

  assertEquals(result.provider, 'copilot');
  assertEquals(config.githubToken, undefined);
  assertEquals(config.githubTokenSet, true);
  assertEquals(config.accountType, 'individual');
  assertEquals(config.user, {
    id: 100,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/avatar.png',
  });
});

test('upstreamRecordToFullJson includes provider config secrets for export', () => {
  const result = upstreamRecordToFullJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(config.bearerToken, 'sk-secret-token-12345');
  assertEquals(config.bearerTokenSet, undefined);
});

// Strict-throw helpers in serialize.ts fail loud rather than silently
// collapse shape drift into nulls. The list endpoint maps
// serializeForResponse over every row, so a single malformed row in
// production blocks `/api/upstreams`. These tests pin that contract.

const codexBase = (overrides: { config?: unknown; state?: unknown }): UpstreamRecord => ({
  id: 'up_cx_test',
  provider: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  config: overrides.config ?? { accounts: [{ email: 'a@example.com' }] },
  state: overrides.state ?? null,
} as unknown as UpstreamRecord);

test('upstreamRecordToJson throws when codex config.accounts is not an array', () => {
  const record = codexBase({ config: { accounts: 'not-an-array' } });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});

test('upstreamRecordToJson throws when codex state.accounts is not an array', () => {
  const record = codexBase({
    config: { accounts: [{ email: 'a@example.com' }] },
    state: { accounts: 'not-an-array' },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});

test('upstreamRecordToJson throws when codex config is not an object', () => {
  const record = codexBase({ config: 'not-an-object' });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed config/);
});

test('upstreamRecordToJson throws when codex state is not an object', () => {
  const record = codexBase({
    config: { accounts: [{ email: 'a@example.com' }] },
    state: 'not-an-object',
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed state/);
});
