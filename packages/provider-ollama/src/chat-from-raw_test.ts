import { test } from 'vitest';

import { chatFromOllamaRaw } from './chat-from-raw.ts';
import type { OllamaRawModel } from './fetch-models.ts';
import { assertEquals } from '@floway-dev/test-utils';

const rawModel = (id: string, capabilities: string[]): OllamaRawModel => ({
  id,
  capabilities: new Set(capabilities),
});

test('chatFromOllamaRaw gpt-oss:20b with thinking → effort branch low/medium/high', () => {
  const chat = chatFromOllamaRaw(rawModel('gpt-oss:20b', ['completion', 'tools', 'thinking']));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});

test('chatFromOllamaRaw gpt-oss-coder (dash suffix) → effort branch', () => {
  const chat = chatFromOllamaRaw(rawModel('gpt-oss-coder', ['thinking']));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});

test('chatFromOllamaRaw deepseek-r1:32b with thinking → adaptive: true', () => {
  const chat = chatFromOllamaRaw(rawModel('deepseek-r1:32b', ['completion', 'thinking']));
  assertEquals(chat, { reasoning: { adaptive: true } });
});

test('chatFromOllamaRaw qwen3:32b with thinking → adaptive: true', () => {
  const chat = chatFromOllamaRaw(rawModel('qwen3:32b', ['thinking']));
  assertEquals(chat, { reasoning: { adaptive: true } });
});

test('chatFromOllamaRaw vision-only → modalities only, no reasoning', () => {
  const chat = chatFromOllamaRaw(rawModel('llava:13b', ['completion', 'vision']));
  assertEquals(chat, { modalities: { input: ['text', 'image'], output: ['text'] } });
});

test('chatFromOllamaRaw vision + thinking (gpt-oss) → both modalities and effort reasoning', () => {
  const chat = chatFromOllamaRaw(rawModel('gpt-oss:120b', ['vision', 'thinking']));
  assertEquals(chat, {
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});

test('chatFromOllamaRaw neither vision nor thinking → undefined', () => {
  assertEquals(chatFromOllamaRaw(rawModel('mistral:7b', ['completion', 'tools'])), undefined);
});

test('chatFromOllamaRaw GPT-OSS:20b uppercase → effort branch (case-insensitive)', () => {
  const chat = chatFromOllamaRaw(rawModel('GPT-OSS:20b', ['thinking']));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});
