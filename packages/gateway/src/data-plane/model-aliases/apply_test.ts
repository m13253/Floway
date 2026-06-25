import { describe, expect, test } from 'vitest';

import {
  applyAliasRulesToChatCompletions,
  applyAliasRulesToGemini,
  applyAliasRulesToMessages,
  applyAliasRulesToResponses,
} from './apply.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Empty-shaped payload helpers; the apply functions only touch the alias-rule
// slots so the rest can stay structurally minimal.
const cc = (overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload => ({ model: 'x', messages: [], ...overrides });
const resp = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({ model: 'x', input: 'hi', ...overrides });
const msg = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({ model: 'x', messages: [], max_tokens: 1, ...overrides });
const gem = (overrides: Partial<GeminiPayload> = {}): GeminiPayload => ({ ...overrides });

describe('applyAliasRulesToChatCompletions', () => {
  test('writes effort to native reasoning_effort and overrides user value', () => {
    const payload = cc({ reasoning_effort: 'low' });
    applyAliasRulesToChatCompletions(payload, { reasoning: { effort: 'high' } });
    expect(payload.reasoning_effort).toBe('high');
  });

  test('writes budgetTokens to extension thinking_budget', () => {
    const payload = cc();
    applyAliasRulesToChatCompletions(payload, { reasoning: { budgetTokens: 4096 } });
    expect(payload.thinking_budget).toBe(4096);
  });

  test('writes adaptive to extension adaptive_thinking', () => {
    const payload = cc();
    applyAliasRulesToChatCompletions(payload, { reasoning: { adaptive: true } });
    expect(payload.adaptive_thinking).toBe(true);
  });

  test('writes summary to extension reasoning_summary', () => {
    const payload = cc();
    applyAliasRulesToChatCompletions(payload, { reasoning: { summary: 'detailed' } });
    expect(payload.reasoning_summary).toBe('detailed');
  });

  test('writes verbosity, serviceTier, anthropicBeta to their slots', () => {
    const payload = cc();
    applyAliasRulesToChatCompletions(payload, {
      verbosity: 'low', serviceTier: 'flex', anthropicBeta: ['ctx-1m'],
    });
    expect(payload.verbosity).toBe('low');
    expect(payload.service_tier).toBe('flex');
    expect(payload.anthropic_beta).toEqual(['ctx-1m']);
  });

  test('leaves payload untouched when rules carry no fields', () => {
    const payload = cc({ reasoning_effort: 'medium', verbosity: 'high' });
    applyAliasRulesToChatCompletions(payload, {});
    expect(payload.reasoning_effort).toBe('medium');
    expect(payload.verbosity).toBe('high');
  });
});

describe('applyAliasRulesToResponses', () => {
  test('writes effort to native reasoning.effort and overrides user value', () => {
    const payload = resp({ reasoning: { effort: 'low' } });
    applyAliasRulesToResponses(payload, { reasoning: { effort: 'high' } });
    expect(payload.reasoning?.effort).toBe('high');
  });

  test('writes summary to native reasoning.summary', () => {
    const payload = resp();
    applyAliasRulesToResponses(payload, { reasoning: { summary: 'detailed' } });
    expect(payload.reasoning?.summary).toBe('detailed');
  });

  test('writes budgetTokens to extension thinking_budget', () => {
    const payload = resp();
    applyAliasRulesToResponses(payload, { reasoning: { budgetTokens: 4096 } });
    expect(payload.thinking_budget).toBe(4096);
  });

  test('writes adaptive to extension adaptive_thinking', () => {
    const payload = resp();
    applyAliasRulesToResponses(payload, { reasoning: { adaptive: true } });
    expect(payload.adaptive_thinking).toBe(true);
  });

  test('writes verbosity to native text.verbosity, preserving format', () => {
    const payload = resp({ text: { format: { type: 'json_object' } } });
    applyAliasRulesToResponses(payload, { verbosity: 'low' });
    expect(payload.text?.verbosity).toBe('low');
    expect(payload.text?.format).toEqual({ type: 'json_object' });
  });

  test('writes serviceTier to native service_tier', () => {
    const payload = resp();
    applyAliasRulesToResponses(payload, { serviceTier: 'flex' });
    expect(payload.service_tier).toBe('flex');
  });

  test('writes anthropicBeta to extension slot', () => {
    const payload = resp();
    applyAliasRulesToResponses(payload, { anthropicBeta: ['ctx-1m'] });
    expect(payload.anthropic_beta).toEqual(['ctx-1m']);
  });
});

describe('applyAliasRulesToMessages', () => {
  test('writes effort to native output_config.effort', () => {
    const payload = msg();
    applyAliasRulesToMessages(payload, { reasoning: { effort: 'high' } });
    expect(payload.output_config?.effort).toBe('high');
  });

  test('writes budgetTokens to thinking.enabled', () => {
    const payload = msg();
    applyAliasRulesToMessages(payload, { reasoning: { budgetTokens: 4096 } });
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  test('writes adaptive to thinking.type=adaptive', () => {
    const payload = msg();
    applyAliasRulesToMessages(payload, { reasoning: { adaptive: true } });
    expect(payload.thinking).toEqual({ type: 'adaptive' });
  });

  test('writes summary to thinking.display (mapped from OpenAI vocabulary)', () => {
    const payload = msg({ thinking: { type: 'enabled', budget_tokens: 1024 } });
    applyAliasRulesToMessages(payload, { reasoning: { summary: 'detailed' } });
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 1024, display: 'summarized' });
  });

  test('writes serviceTier to native service_tier', () => {
    const payload = msg();
    applyAliasRulesToMessages(payload, { serviceTier: 'priority' });
    expect(payload.service_tier).toBe('priority');
  });

  test('writes verbosity to the extension slot', () => {
    const payload = msg();
    applyAliasRulesToMessages(payload, { verbosity: 'low' });
    expect(payload.verbosity).toBe('low');
  });

  test('adaptive overrides budgetTokens when both arrive on the same call', () => {
    // The write-side validator forbids both, but if both still arrive the
    // adaptive choice has to win to match the translate-layer policy.
    const payload = msg();
    applyAliasRulesToMessages(payload, { reasoning: { budgetTokens: 1024, adaptive: true } });
    expect(payload.thinking).toEqual({ type: 'adaptive' });
  });
});

describe('applyAliasRulesToGemini', () => {
  test('writes effort to generationConfig.thinkingConfig.thinkingLevel', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { reasoning: { effort: 'high' } });
    expect(payload.generationConfig?.thinkingConfig?.thinkingLevel).toBe('high');
  });

  test('writes budgetTokens to generationConfig.thinkingConfig.thinkingBudget', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { reasoning: { budgetTokens: 4096 } });
    expect(payload.generationConfig?.thinkingConfig?.thinkingBudget).toBe(4096);
  });

  test('writes adaptive to generationConfig.thinkingConfig.thinkingBudget = -1', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { reasoning: { adaptive: true } });
    expect(payload.generationConfig?.thinkingConfig?.thinkingBudget).toBe(-1);
  });

  test('writes summary to generationConfig.thinkingConfig.includeThoughts when not omitted', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { reasoning: { summary: 'detailed' } });
    expect(payload.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
  });

  test('writes summary=omitted to generationConfig.thinkingConfig.includeThoughts=false', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { reasoning: { summary: 'omitted' } });
    expect(payload.generationConfig?.thinkingConfig?.includeThoughts).toBe(false);
  });

  test('writes verbosity to generationConfig.verbosity extension', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { verbosity: 'low' });
    expect(payload.generationConfig?.verbosity).toBe('low');
  });

  test('writes serviceTier to generationConfig.serviceTier extension', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { serviceTier: 'flex' });
    expect(payload.generationConfig?.serviceTier).toBe('flex');
  });

  test('writes anthropicBeta to top-level extension slot', () => {
    const payload = gem();
    applyAliasRulesToGemini(payload, { anthropicBeta: ['ctx-1m'] });
    expect(payload.anthropicBeta).toEqual(['ctx-1m']);
  });

  test('preserves existing thinkingConfig entries when adding a new one', () => {
    const payload = gem({ generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
    applyAliasRulesToGemini(payload, { reasoning: { summary: 'detailed' } });
    expect(payload.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });
  });
});
