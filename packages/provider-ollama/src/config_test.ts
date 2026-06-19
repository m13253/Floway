import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from './config.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_ollama_test',
  provider: 'ollama',
  name: 'Ollama Cloud',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {
    baseUrl: 'https://ollama.com',
    apiKey: 'ollama_test',
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
};

test('assertOllamaUpstreamRecord parses a minimum cloud config', () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  assertEquals(config.baseUrl, 'https://ollama.com');
  assertEquals(config.apiKey, 'ollama_test');
  assertEquals(config.models, []);
});

test('assertOllamaUpstreamRecord accepts a self-hosted base URL without an api key', () => {
  const { config } = assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: 'http://127.0.0.1:11434' },
  });
  assertEquals(config.baseUrl, 'http://127.0.0.1:11434');
  assertEquals(config.apiKey, undefined);
});

test('assertOllamaUpstreamRecord parses manual model overrides', () => {
  const { config } = assertOllamaUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        { upstreamModelId: 'gpt-oss:120b', endpoints: { chatCompletions: {} }, display_name: 'GPT-OSS 120B' },
      ],
    },
  });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'gpt-oss:120b');
  assertEquals(config.models[0].display_name, 'GPT-OSS 120B');
});

test('assertOllamaUpstreamRecord rejects a non-http(s) base URL', () => {
  assertThrows(() => assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: 'ftp://example.com' },
  }));
});

test('assertOllamaUpstreamRecord rejects a missing base URL', () => {
  assertThrows(() => assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: '' },
  }));
});

test('pricingForOllamaModelKey returns table rates for known model ids', () => {
  const gptOss = pricingForOllamaModelKey('gpt-oss:120b');
  assertEquals(gptOss?.input, 0.15);
  assertEquals(gptOss?.output, 0.6);
});

test('pricingForOllamaModelKey matches regex-keyed families', () => {
  // glm-5 family table covers 5 / 5.1 / 5.2 with one regex entry.
  const glm52 = pricingForOllamaModelKey('glm-5.2');
  assertEquals(glm52?.input, 1.4);
  assertEquals(glm52?.output, 4.4);

  // Gemma's regex covers any gemma3/gemma4 size suffix.
  const gemma = pricingForOllamaModelKey('gemma4:31b');
  assertEquals(gemma?.input, 0);
  assertEquals(gemma?.output, 0);
});

test('pricingForOllamaModelKey returns null for ids without a defensible reference', () => {
  // Ollama-exclusive distillation — deliberately omitted from the table.
  assertEquals(pricingForOllamaModelKey('rnj-1:8b'), null);
  // Version that does not map to any upstream release.
  assertEquals(pricingForOllamaModelKey('qwen3.5'), null);
});
