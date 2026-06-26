// Behavioral coverage for the per-protocol rule overlay. Each protocol's
// apply helper is exercised against an inbound payload IR; alias rules are
// authoritative — an existing IR field is OVERWRITTEN by a matching rule
// — and rules the IR cannot express are silently dropped.

import { test } from 'vitest';

import { applyChatRulesToChatCompletions, applyChatRulesToGemini, applyChatRulesToMessages, applyChatRulesToResponses } from './apply.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

const ccPayload = (overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload => ({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const resPayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'gpt-5.4',
  input: 'hi',
  ...overrides,
});

const msgPayload = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({
  model: 'claude-opus-4-7',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const gemPayload = (overrides: Partial<GeminiPayload> = {}): GeminiPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  ...overrides,
});

// ── ChatCompletions ──

test('chat-completions: empty rules leave the payload unchanged', () => {
  const body = ccPayload({ reasoning_effort: 'high', verbosity: 'low', service_tier: 'priority' });
  applyChatRulesToChatCompletions(body, {});
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('chat-completions: rules stamp every supported field onto the IR', () => {
  const body = ccPayload();
  applyChatRulesToChatCompletions(body, {
    reasoning: { effort: 'high', budget_tokens: 1024, adaptive: true, summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'high');
  assertEquals(body.thinking_budget, 1024);
  assertEquals(body.adaptive_thinking, true);
  assertEquals(body.reasoning_summary, 'detailed');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('chat-completions: alias rules overwrite existing IR fields', () => {
  const body = ccPayload({ reasoning_effort: 'low', verbosity: 'high', service_tier: 'default' });
  applyChatRulesToChatCompletions(body, {
    reasoning: { effort: 'xhigh' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning_effort, 'xhigh');
  assertEquals(body.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── Responses ──

test('responses: empty rules leave the payload unchanged', () => {
  const body = resPayload({ reasoning: { effort: 'high' }, text: { verbosity: 'low' }, service_tier: 'priority' });
  applyChatRulesToResponses(body, {});
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

test('responses: rules stamp every supported field onto the IR', () => {
  const body = resPayload();
  applyChatRulesToResponses(body, {
    reasoning: { effort: 'high', budget_tokens: 1024, adaptive: true, summary: 'concise' },
    verbosity: 'medium',
    serviceTier: 'flex',
  });
  assertEquals(body.reasoning?.effort, 'high');
  assertEquals(body.reasoning?.summary, 'concise');
  assertEquals(body.thinking_budget, 1024);
  assertEquals(body.adaptive_thinking, true);
  assertEquals(body.text?.verbosity, 'medium');
  assertEquals(body.service_tier, 'flex');
});

test('responses: alias rules overwrite existing reasoning + service_tier fields', () => {
  const body = resPayload({ reasoning: { effort: 'low', summary: 'auto' }, service_tier: 'default', text: { verbosity: 'high' } });
  applyChatRulesToResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning?.effort, 'xhigh');
  assertEquals(body.reasoning?.summary, 'detailed');
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'priority');
});

// ── Messages ──

test('messages: empty rules leave the payload unchanged', () => {
  const body = msgPayload({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 512 }, speed: 'fast' });
  applyChatRulesToMessages(body, {});
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.budget_tokens, 512);
  assertEquals(body.speed, 'fast');
});

test('messages: effort lands on output_config, budget+adaptive land on thinking', () => {
  const body = msgPayload();
  applyChatRulesToMessages(body, {
    reasoning: { effort: 'high', budget_tokens: 2048 },
    verbosity: 'low',
  });
  assertEquals(body.output_config?.effort, 'high');
  assertEquals(body.thinking?.type, 'enabled');
  assertEquals(body.thinking?.budget_tokens, 2048);
  assertEquals(body.verbosity, 'low');
});

test('messages: adaptive=true sets thinking.type=adaptive and ignores budget_tokens', () => {
  const body = msgPayload();
  applyChatRulesToMessages(body, { reasoning: { adaptive: true, budget_tokens: 4096 } });
  assertEquals(body.thinking?.type, 'adaptive');
});

test('messages: serviceTier=fast maps to speed=fast (cross-protocol bridge)', () => {
  const body = msgPayload();
  applyChatRulesToMessages(body, { serviceTier: 'fast' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, undefined);
});

test('messages: non-fast serviceTier lands on service_tier directly', () => {
  const body = msgPayload();
  applyChatRulesToMessages(body, { serviceTier: 'priority' });
  assertEquals(body.service_tier, 'priority');
  assertEquals(body.speed, undefined);
});

test('messages: alias rules overwrite existing thinking + output_config fields', () => {
  const body = msgPayload({ output_config: { effort: 'low' }, thinking: { type: 'enabled', budget_tokens: 100 } });
  applyChatRulesToMessages(body, { reasoning: { effort: 'xhigh', budget_tokens: 9999 } });
  assertEquals(body.output_config?.effort, 'xhigh');
  assertEquals(body.thinking?.budget_tokens, 9999);
});

// ── Gemini ──

test('gemini: empty rules leave the payload unchanged', () => {
  const body = gemPayload({ generationConfig: { thinkingConfig: { thinkingBudget: 256 }, verbosity: 'low' } });
  applyChatRulesToGemini(body, {});
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingBudget, 256);
  assertEquals(body.generationConfig?.verbosity, 'low');
});

test('gemini: effort maps to thinkingLevel; budget lands on thinkingBudget', () => {
  const body = gemPayload();
  applyChatRulesToGemini(body, {
    reasoning: { effort: 'high', budget_tokens: 1024 },
    verbosity: 'medium',
    serviceTier: 'flex',
  });
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingLevel, 'high');
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingBudget, 1024);
  assertEquals(body.generationConfig?.verbosity, 'medium');
  assertEquals(body.generationConfig?.serviceTier, 'flex');
});

test('gemini: adaptive=true encodes thinkingBudget=-1 and overrides any budget_tokens', () => {
  const body = gemPayload();
  applyChatRulesToGemini(body, { reasoning: { adaptive: true, budget_tokens: 9999 } });
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingBudget, -1);
});

test('gemini: alias rules overwrite existing generationConfig fields', () => {
  const body = gemPayload({ generationConfig: { thinkingConfig: { thinkingBudget: 100, thinkingLevel: 'low' }, verbosity: 'high', serviceTier: 'default' } });
  applyChatRulesToGemini(body, { reasoning: { effort: 'xhigh', budget_tokens: 2048 }, verbosity: 'low', serviceTier: 'priority' });
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingLevel, 'xhigh');
  assertEquals(body.generationConfig?.thinkingConfig?.thinkingBudget, 2048);
  assertEquals(body.generationConfig?.verbosity, 'low');
  assertEquals(body.generationConfig?.serviceTier, 'priority');
});
