import type { ModelAliasRules } from '../../control-plane/model-aliases/types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload, MessagesThinkingDisplay } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { mapSummaryToAnthropicDisplay } from '@floway-dev/translate/via-messages/anthropic-extensions';

// Each function writes the alias rules into the inbound IR's slot best suited
// to the host protocol: native when the protocol can express the concept,
// extension otherwise. Writes overwrite any user-supplied value — aliases are
// operator-locked per Goal 3. Mapping table is the single source of truth in
// docs/superpowers/specs/2026-06-25-model-aliases-design.md.

export const applyAliasRulesToChatCompletions = (payload: ChatCompletionsPayload, rules: ModelAliasRules): void => {
  // reasoning.effort is native; budget/adaptive/summary ride on extension slots
  // because Chat Completions has no native expression for those.
  if (rules.reasoning?.effort !== undefined) payload.reasoning_effort = rules.reasoning.effort;
  if (rules.reasoning?.budgetTokens !== undefined) payload.thinking_budget = rules.reasoning.budgetTokens;
  if (rules.reasoning?.adaptive === true) payload.adaptive_thinking = true;
  if (rules.reasoning?.summary !== undefined) payload.reasoning_summary = rules.reasoning.summary;
  if (rules.verbosity !== undefined) payload.verbosity = rules.verbosity;
  if (rules.serviceTier !== undefined) payload.service_tier = rules.serviceTier;
  if (rules.anthropicSpeed !== undefined) payload.anthropic_speed = rules.anthropicSpeed;
  if (rules.anthropicBeta?.length) payload.anthropic_beta = [...rules.anthropicBeta];
};

export const applyAliasRulesToResponses = (payload: ResponsesPayload, rules: ModelAliasRules): void => {
  // reasoning.{effort, summary} and text.verbosity / service_tier are native;
  // budget/adaptive ride on extension slots; the two anthropic_* knobs only
  // matter when this Responses inbound lands on a Messages upstream.
  if (rules.reasoning?.effort !== undefined) payload.reasoning = { ...payload.reasoning, effort: rules.reasoning.effort };
  if (rules.reasoning?.summary !== undefined) payload.reasoning = { ...payload.reasoning, summary: rules.reasoning.summary };
  if (rules.reasoning?.budgetTokens !== undefined) payload.thinking_budget = rules.reasoning.budgetTokens;
  if (rules.reasoning?.adaptive === true) payload.adaptive_thinking = true;
  if (rules.verbosity !== undefined) payload.text = { ...payload.text, verbosity: rules.verbosity };
  if (rules.serviceTier !== undefined) payload.service_tier = rules.serviceTier;
  if (rules.anthropicSpeed !== undefined) payload.anthropic_speed = rules.anthropicSpeed;
  if (rules.anthropicBeta?.length) payload.anthropic_beta = [...rules.anthropicBeta];
};

export const applyAliasRulesToMessages = (payload: MessagesPayload, rules: ModelAliasRules): void => {
  // Anthropic has natives for effort, thinking, speed, and service_tier; only
  // verbosity is a Floway extension on this inbound. anthropic_beta is the
  // wire header — the attempt layer reads `candidate.aliasRules.anthropicBeta`
  // and merges via mergeAnthropicBetaTokens, so we do not stamp the body here.
  if (rules.reasoning?.effort !== undefined) {
    payload.output_config = { ...payload.output_config, effort: rules.reasoning.effort };
  }
  // Adaptive wins over budgetTokens when both arrive — the write-side
  // validator forbids the combination, but the apply step has to make a
  // choice if both slip through and the translate-layer policy is
  // adaptive-first.
  if (rules.reasoning?.adaptive === true) {
    payload.thinking = { type: 'adaptive' };
  } else if (rules.reasoning?.budgetTokens !== undefined) {
    payload.thinking = { type: 'enabled', budget_tokens: rules.reasoning.budgetTokens };
  }
  if (rules.reasoning?.summary !== undefined) {
    const display = mapSummaryToAnthropicDisplay(rules.reasoning.summary);
    if (display !== undefined) {
      // When no prior thinking branch ran (no effort/budget/adaptive in this
      // rule), synthesize `thinking: {type:'enabled', display}` so the
      // operator's summary intent survives — Anthropic discards `display`
      // without `type`. Matches `buildMessagesThinkingFromExtensions`.
      const base = payload.thinking ?? { type: 'enabled' as const };
      payload.thinking = { ...base, display: display as MessagesThinkingDisplay };
    }
  }
  if (rules.verbosity !== undefined) payload.verbosity = rules.verbosity;
  if (rules.serviceTier !== undefined) payload.service_tier = rules.serviceTier;
  if (rules.anthropicSpeed !== undefined) payload.speed = rules.anthropicSpeed;
};

export const applyAliasRulesToGemini = (payload: GeminiPayload, rules: ModelAliasRules): void => {
  // All four reasoning knobs ride on the native thinkingConfig; verbosity and
  // serviceTier ride on extension slots under generationConfig; the
  // anthropic_* knobs ride on top-level extension slots so the existing
  // gemini-via-messages translator picks them up there.
  const hasThinking = rules.reasoning?.effort !== undefined
    || rules.reasoning?.budgetTokens !== undefined
    || rules.reasoning?.adaptive === true
    || rules.reasoning?.summary !== undefined;
  const hasGenerationConfig = hasThinking || rules.verbosity !== undefined || rules.serviceTier !== undefined;

  if (hasGenerationConfig) {
    const generationConfig = { ...payload.generationConfig };
    const thinkingConfig = { ...generationConfig.thinkingConfig };
    if (rules.reasoning?.effort !== undefined) thinkingConfig.thinkingLevel = rules.reasoning.effort;
    if (rules.reasoning?.budgetTokens !== undefined) thinkingConfig.thinkingBudget = rules.reasoning.budgetTokens;
    if (rules.reasoning?.adaptive === true) thinkingConfig.thinkingBudget = -1;
    if (rules.reasoning?.summary !== undefined) {
      // Gemini exposes a single boolean for summary; map summary='omitted' to
      // false and every other value (auto / concise / detailed / freeform) to
      // true. Operators that want to fall back to Gemini's account default
      // simply omit `reasoning.summary` from the rule.
      thinkingConfig.includeThoughts = rules.reasoning.summary !== 'omitted';
    }
    if (hasThinking) generationConfig.thinkingConfig = thinkingConfig;
    if (rules.verbosity !== undefined) generationConfig.verbosity = rules.verbosity;
    if (rules.serviceTier !== undefined) generationConfig.serviceTier = rules.serviceTier;
    payload.generationConfig = generationConfig;
  }
  if (rules.anthropicSpeed !== undefined) payload.anthropicSpeed = rules.anthropicSpeed;
  if (rules.anthropicBeta?.length) payload.anthropicBeta = [...rules.anthropicBeta];
};
