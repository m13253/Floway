// Synthesizes the alias entries that join the real-model catalog inside
// `/v1/models`. One PublicModel per visible alias — hidden aliases
// (visible_in_models_list = false) are dropped from the listing while
// remaining routable. The synthesized entry carries an `aliasedFrom` block
// so an alias-aware UI (today: the dashboard) can render the alias-of
// relationship without a second round trip.
//
// Capability metadata is the safe lower bound for the inbound request:
//   • single-target → the sole target's metadata, narrowed by the alias's
//     `rules` (a fixed reasoning effort collapses the reported effort set
//     to that one value, a fixed budget collapses the reported range to
//     a single point).
//   • multi-target → the intersection across every currently-available
//     target. A capability survives only when every target backing the
//     alias declares it; whichever target gets picked at request time is
//     then guaranteed to support whatever the catalog reported.
//
// "Available target" for intersection purposes means a target whose
// `target_model_id` appears in `realModels` AND whose entry's `kind`
// matches the alias's `kind`. Unavailable targets are excluded from the
// intersection but still appear in `aliasedFrom.targets` so the dashboard
// can show the full configuration.
//
// Collision: when an alias's `name` exactly equals a real model id, the
// alias entry replaces the real entry in the final catalog. Two entries
// with the same `id` would break OpenAI client deduplication; collapsing
// to the alias entry preserves the operator's intent (the alias is the
// reason both rows would have been present). The dashboard surfaces this
// via a shadow warning in the alias editor; here it is purely a wire-shape
// concern. The real entry is removed at the `loadModels` merge step.

import type { ModelAliasRecord } from '../../repo/types.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import type { AliasTarget, ChatAliasRules, ChatModelInfo, PublicModel, PublicModelAliasedFrom } from '@floway-dev/protocols/common';
import type { InternalModel } from '@floway-dev/provider';

export interface ListedAliasInputs {
  readonly aliases: readonly ModelAliasRecord[];
  readonly realModels: readonly InternalModel[];
}

// The repo guarantees rule shape matches the row's `kind` (chat rows carry
// `ChatAliasRules`; embedding / image rows carry the empty record), so a
// chat-row target can be read as ChatAliasRules without a runtime check.
const chatRules = (target: AliasTarget): ChatAliasRules => target.rules as ChatAliasRules;

// Result preserves the order of `arrays[0]`. Matters for callers like the
// reasoning-effort intersection below: when no agreed-default exists, the
// fallback default is `supported[0]`, so the first input's relative order
// determines which level wins as the listing's `default`.
const intersectArrays = <T>(arrays: readonly (readonly T[])[]): T[] => {
  if (arrays.length === 0) return [];
  const [head, ...tail] = arrays;
  return head.filter(value => tail.every(other => other.includes(value)));
};

const intersectChat = (chats: readonly ChatModelInfo[]): ChatModelInfo | undefined => {
  if (chats.length === 0) return undefined;
  const result: ChatModelInfo = {};

  const modalityChats = chats.filter(c => c.modalities !== undefined);
  if (modalityChats.length === chats.length) {
    const input = intersectArrays(modalityChats.map(c => c.modalities!.input));
    const output = intersectArrays(modalityChats.map(c => c.modalities!.output));
    if (input.length > 0 || output.length > 0) result.modalities = { input, output };
  }

  const reasoningChats = chats.filter(c => c.reasoning !== undefined);
  if (reasoningChats.length === chats.length) {
    const reasoning: NonNullable<ChatModelInfo['reasoning']> = {};

    const effortChats = reasoningChats.filter(c => c.reasoning!.effort !== undefined);
    if (effortChats.length === reasoningChats.length) {
      const supported = intersectArrays(effortChats.map(c => c.reasoning!.effort!.supported));
      const defaults = new Set(effortChats.map(c => c.reasoning!.effort!.default));
      // Intersection's `default` is the agreed value when every target
      // names the same one and that value still survives the supported
      // intersection; otherwise we report supported-only.
      if (supported.length > 0) {
        const agreedDefault = defaults.size === 1 ? [...defaults][0] : undefined;
        reasoning.effort = agreedDefault !== undefined && supported.includes(agreedDefault)
          ? { supported, default: agreedDefault }
          : { supported, default: supported[0] };
      }
    }

    const budgetChats = reasoningChats.filter(c => c.reasoning!.budget_tokens !== undefined);
    if (budgetChats.length === reasoningChats.length) {
      const mins = budgetChats.map(c => c.reasoning!.budget_tokens!.min).filter((v): v is number => v !== undefined);
      const maxes = budgetChats.map(c => c.reasoning!.budget_tokens!.max).filter((v): v is number => v !== undefined);
      const min = mins.length === budgetChats.length ? Math.max(...mins) : undefined;
      const max = maxes.length === budgetChats.length ? Math.min(...maxes) : undefined;
      // Drop the budget block entirely when the intersected window is
      // empty (every caller would otherwise see a contradictory range).
      if (!(min !== undefined && max !== undefined && min > max)) {
        const budget: NonNullable<NonNullable<ChatModelInfo['reasoning']>['budget_tokens']> = {};
        if (min !== undefined) budget.min = min;
        if (max !== undefined) budget.max = max;
        if (min !== undefined || max !== undefined) reasoning.budget_tokens = budget;
      }
    }

    const adaptiveAgreed = new Set(reasoningChats.map(c => c.reasoning!.adaptive));
    if (adaptiveAgreed.size === 1) {
      const value = [...adaptiveAgreed][0];
      if (value !== undefined) reasoning.adaptive = value;
    }
    const mandatoryAgreed = new Set(reasoningChats.map(c => c.reasoning!.mandatory));
    if (mandatoryAgreed.size === 1) {
      const value = [...mandatoryAgreed][0];
      if (value !== undefined) reasoning.mandatory = value;
    }

    if (Object.keys(reasoning).length > 0) result.reasoning = reasoning;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

// Narrow the single target's chat metadata against the alias's rule
// overlay. Fields the rule doesn't touch pass through unchanged.
const narrowChatByRules = (chat: ChatModelInfo | undefined, target: AliasTarget): ChatModelInfo | undefined => {
  if (chat === undefined) return undefined;
  const rules = chatRules(target);
  if (rules.reasoning === undefined) return chat;
  const out: ChatModelInfo = { ...chat };
  if (chat.reasoning !== undefined) {
    const reasoning: NonNullable<ChatModelInfo['reasoning']> = { ...chat.reasoning };
    if (rules.reasoning.effort !== undefined) {
      const fixed = rules.reasoning.effort;
      reasoning.effort = { supported: [fixed], default: fixed };
    }
    if (rules.reasoning.budget_tokens !== undefined) {
      const fixed = rules.reasoning.budget_tokens;
      reasoning.budget_tokens = { min: fixed, max: fixed };
    }
    out.reasoning = reasoning;
  }
  return out;
};

const deriveDisplayName = (alias: ModelAliasRecord): string => {
  if (alias.displayName !== null) return alias.displayName;
  if (alias.targets.length === 1) return composeAliasDisplayName(alias.targets[0].target_model_id, alias.targets[0].rules);
  return alias.name;
};

const buildAliasedFrom = (alias: ModelAliasRecord): PublicModelAliasedFrom => ({
  name: alias.name,
  kind: alias.kind,
  selection: alias.selection,
  // Every configured target — including ones the live catalog can not
  // serve — so the dashboard can show the full configuration.
  targets: alias.targets,
});

const synthesizeOne = (alias: ModelAliasRecord, realModels: readonly InternalModel[]): PublicModel => {
  const realById = new Map(realModels.map(m => [m.id, m] as const));
  const availableTargets = alias.targets
    .map(target => ({ target, real: realById.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; real: InternalModel } => entry.real !== undefined && entry.real.kind === alias.kind);

  const entry: PublicModel = {
    id: alias.name,
    object: 'model',
    type: 'model',
    display_name: deriveDisplayName(alias),
    limits: {},
    kind: alias.kind,
    aliasedFrom: buildAliasedFrom(alias),
  };

  // No backing target — still emit the row so the dashboard can show the
  // alias with a no-target warning. Capability metadata stays absent so
  // clients see no inherited claims.
  if (availableTargets.length === 0) return entry;

  if (availableTargets.length === 1) {
    const [{ target, real }] = availableTargets;
    if (real.chat !== undefined) {
      const chat = narrowChatByRules(real.chat, target);
      if (chat !== undefined) entry.chat = chat;
    }
    if (real.cost !== undefined) entry.cost = real.cost;
    return entry;
  }

  const chats = availableTargets.map(({ real }) => real.chat).filter((c): c is ChatModelInfo => c !== undefined);
  // Intersect chat metadata only when every available target declares it;
  // a half-declared block would leak the metadata of whichever subset
  // happened to carry it.
  if (chats.length === availableTargets.length) {
    const chat = intersectChat(chats);
    if (chat !== undefined) entry.chat = chat;
  }
  return entry;
};

const sortAliases = (aliases: readonly ModelAliasRecord[]): ModelAliasRecord[] =>
  [...aliases].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

export const synthesizeListedAliases = (input: ListedAliasInputs): PublicModel[] =>
  sortAliases(input.aliases)
    .filter(alias => alias.visibleInModelsList)
    .map(alias => synthesizeOne(alias, input.realModels));
