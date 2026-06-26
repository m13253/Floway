// Per-protocol rule overlay. Alias rules overwrite IR fields they name;
// fields the target IR cannot express are silently dropped. The functions
// accept the resolver's wide `AliasRules` union and narrow internally —
// non-chat aliases carry an empty rules object so the chat-only fields are
// all undefined and the overlay is a no-op.

import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { AliasRules, ChatAliasRules } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

// Per-request response header that names the alias the inbound id resolved
// through. Downstream observability ties together "client asked for X" /
// "upstream saw Y" via this header.
export const ALIAS_RESPONSE_HEADER = 'x-floway-alias';

const asChat = (rules: AliasRules): ChatAliasRules => rules as ChatAliasRules;

const hasReasoning = (rules: ChatAliasRules): rules is ChatAliasRules & { reasoning: NonNullable<ChatAliasRules['reasoning']> } =>
  rules.reasoning !== undefined;

export const applyChatRulesToChatCompletions = (body: ChatCompletionsPayload, rules: AliasRules): void => {
  const chat = asChat(rules);
  if (hasReasoning(chat)) {
    const { effort, budget_tokens, adaptive, summary } = chat.reasoning;
    if (effort !== undefined) body.reasoning_effort = effort;
    if (budget_tokens !== undefined) body.thinking_budget = budget_tokens;
    if (adaptive !== undefined) body.adaptive_thinking = adaptive;
    if (summary !== undefined) body.reasoning_summary = summary;
  }
  if (chat.verbosity !== undefined) body.verbosity = chat.verbosity;
  if (chat.serviceTier !== undefined) body.service_tier = chat.serviceTier;
};

export const applyChatRulesToResponses = (body: ResponsesPayload, rules: AliasRules): void => {
  const chat = asChat(rules);
  if (hasReasoning(chat)) {
    const { effort, budget_tokens, adaptive, summary } = chat.reasoning;
    if (effort !== undefined || summary !== undefined) {
      const existing = body.reasoning ?? {};
      body.reasoning = {
        ...existing,
        ...(effort !== undefined ? { effort } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    if (budget_tokens !== undefined) body.thinking_budget = budget_tokens;
    if (adaptive !== undefined) body.adaptive_thinking = adaptive;
  }
  if (chat.verbosity !== undefined) {
    body.text = { ...body.text, verbosity: chat.verbosity };
  }
  if (chat.serviceTier !== undefined) body.service_tier = chat.serviceTier;
};

export const applyChatRulesToMessages = (body: MessagesPayload, rules: AliasRules): void => {
  const chat = asChat(rules);
  if (hasReasoning(chat)) {
    const { effort, budget_tokens, adaptive } = chat.reasoning;
    // Anthropic stores explicit effort in `output_config.effort`; budget /
    // adaptive ride on `thinking.*`. Splitting them so both can be set in
    // the same overlay (effort fixed + budget pinned, e.g.) without one
    // erasing the other.
    if (effort !== undefined) {
      body.output_config = { ...body.output_config, effort };
    }
    if (adaptive === true) {
      body.thinking = { ...body.thinking, type: 'adaptive' };
    } else if (budget_tokens !== undefined) {
      body.thinking = { ...body.thinking, type: 'enabled', budget_tokens };
    }
  }
  if (chat.verbosity !== undefined) body.verbosity = chat.verbosity;
  if (chat.serviceTier !== undefined) {
    // The cross-protocol bridge in translate maps `speed: 'fast'` ↔
    // `service_tier: 'fast'`; on a native Messages target the alias rule
    // `serviceTier: 'fast'` lands on `speed` so the upstream sees Fast Mode
    // through its native field. Other tier values pass through on
    // `service_tier` since Messages's native enum (`auto`/`standard_only`)
    // doesn't model them.
    if (chat.serviceTier === 'fast') {
      body.speed = 'fast';
    } else {
      body.service_tier = chat.serviceTier;
    }
  }
};

// Discrete effort presets map onto Gemini's `thinkingLevel` enum; unknown
// values are dropped because Gemini rejects out-of-enum tiers upstream.
const GEMINI_THINKING_LEVEL_BY_EFFORT: Record<string, 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'> = {
  none: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export const applyChatRulesToGemini = (body: GeminiPayload, rules: AliasRules): void => {
  const chat = asChat(rules);
  if (hasReasoning(chat)) {
    const { effort, budget_tokens, adaptive } = chat.reasoning;
    // Gemini collapses the three reasoning controls onto one `thinkingConfig`
    // sub-object. Adaptive wins by encoding budget=-1 (Gemini's adaptive
    // sentinel); an explicit budget pins the count; effort sets the level.
    const thinkingConfig = { ...body.generationConfig?.thinkingConfig };
    if (adaptive === true) {
      thinkingConfig.thinkingBudget = -1;
    } else if (budget_tokens !== undefined) {
      thinkingConfig.thinkingBudget = budget_tokens;
    }
    if (effort !== undefined) {
      const level = GEMINI_THINKING_LEVEL_BY_EFFORT[effort];
      if (level !== undefined) thinkingConfig.thinkingLevel = level;
    }
    if (Object.keys(thinkingConfig).length > 0) {
      body.generationConfig = { ...body.generationConfig, thinkingConfig };
    }
  }
  if (chat.verbosity !== undefined) {
    body.generationConfig = { ...body.generationConfig, verbosity: chat.verbosity };
  }
  if (chat.serviceTier !== undefined) {
    body.generationConfig = { ...body.generationConfig, serviceTier: chat.serviceTier };
  }
};
