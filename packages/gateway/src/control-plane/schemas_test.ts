import { describe, expect, test } from 'vitest';
import { createUpstreamBody } from './schemas.ts';

const baseAzure = {
  provider: 'azure' as const,
  name: 'azure',
  config: {
    endpoint: 'https://a.example.com',
    apiKey: 'k',
    models: [{
      upstreamModelId: 'm',
      kind: 'chat' as const,
      endpoints: { chatCompletions: {} },
    }],
  },
};

describe('upstreamModelSchema chat', () => {
  test('accepts a valid chat block', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { supported_efforts: ['low', 'medium'], default_effort: 'low' },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('rejects chat on non-chat kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'embedding';
    model.endpoints = { embeddings: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects default_effort not in supported_efforts', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { supported_efforts: ['low', 'high'], default_effort: 'medium' },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('accepts output modalities without text', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text'], output: ['image'] },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('rejects empty output modalities array', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text'], output: [] },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });
});
