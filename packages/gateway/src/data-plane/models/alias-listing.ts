// Synthesizes the alias entries that join the real-model catalog inside
// `/v1/models`. One PublicModel per visible alias. The synthesized entry
// carries an `aliasedFrom` block so an alias-aware UI can render the
// alias-of relationship without a second round trip.
//
// `limits` and `chat` come from the alias's announced metadata payload:
// the operator's stored override when set (sparse — any sub-field they
// did not provide falls back to the automatic computation), otherwise
// the rule-aware intersection across the alias's available targets. The
// intersection is the safe lower bound for the inbound request — every
// reported capability survives no matter which target the resolver
// picks at request time.
//
// The rule-aware part: when an alias's rule pins a value at a target,
// that target is treated as "unsupported" for the corresponding
// sub-field for the purposes of the intersection. A pinned rule
// already fixes whatever value the listing would have advertised, so
// dropping the sub-field from the announced metadata keeps the wire
// surface honest about what the operator left for the caller to set.
//
// Collision: when an alias's `name` exactly equals a real model id, the
// alias entry replaces the real entry in the final catalog. Two entries
// with the same `id` would break OpenAI client deduplication; collapsing
// to the alias entry preserves the operator's intent (the alias is the
// reason both rows would have been present). The real entry is removed
// at the `loadModels` merge step.

import type { ModelAliasRecord } from '../../repo/types.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import type { AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ModelEndpointKey, ModelEndpoints, PublicModel, PublicModelAliasedFrom, PublicModelLimits } from '@floway-dev/protocols/common';
import type { ResolvedModel } from '@floway-dev/provider';

export interface ListedAliasInputs {
  readonly aliases: readonly ModelAliasRecord[];
  readonly realModels: readonly ResolvedModel[];
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

// Endpoint intersection: a key survives iff every target advertises it.
// Sub-capability flags inside a key (the inner object) are ANDed
// conservatively — present in the result iff every contributing target
// declares them. Today every endpoint value is the empty object, so the
// AND collapses to an empty object too; the structure is in place so a
// future sub-cap addition lands without re-engineering this helper.
const intersectEndpoints = (endpointsList: readonly ModelEndpoints[]): ModelEndpoints => {
  if (endpointsList.length === 0) return {};
  const keys = Object.keys(endpointsList[0]) as ModelEndpointKey[];
  const result: ModelEndpoints = {};
  for (const key of keys) {
    if (!endpointsList.every(e => e[key] !== undefined)) continue;
    const subCaps = endpointsList.map(e => e[key]!);
    const merged: Record<string, unknown> = { ...subCaps[0] };
    for (const cap of subCaps.slice(1)) {
      for (const flag of Object.keys(merged)) {
        if ((cap as Record<string, unknown>)[flag] === undefined) delete merged[flag];
      }
    }
    result[key] = merged as ModelEndpoints[typeof key];
  }
  return result;
};

// Apply the rule-driven downgrade: a target with a pinned rule reports
// the corresponding catalog sub-field as unsupported (= undefined) for
// the purposes of intersection. Fields the rule doesn't touch pass
// through unchanged.
const effectiveChatForIntersection = (chat: ChatModelInfo | undefined, target: AliasTarget): ChatModelInfo | undefined => {
  if (chat === undefined) return undefined;
  const rules = chatRules(target);
  const ruleReasoning = rules.reasoning;
  if (ruleReasoning === undefined) return chat;
  if (chat.reasoning === undefined) return chat;

  const reasoning: NonNullable<ChatModelInfo['reasoning']> = { ...chat.reasoning };
  if (ruleReasoning.effort !== undefined) delete reasoning.effort;
  if (ruleReasoning.budget_tokens !== undefined) delete reasoning.budget_tokens;
  if (ruleReasoning.adaptive === true) delete reasoning.adaptive;

  return { ...chat, reasoning };
};

const intersectChat = (chats: readonly ChatModelInfo[]): ChatModelInfo | undefined => {
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

// `limits` intersection: min across targets per field; the field is
// absent when any target leaves it undeclared. Matches the safe-lower-
// bound contract — whichever target the resolver picks, the reported
// window is one every target can actually serve.
const LIMIT_KEYS = ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'] as const;

const intersectLimits = (limitsList: readonly PublicModelLimits[]): PublicModelLimits => {
  if (limitsList.length === 0) return {};
  const result: PublicModelLimits = {};
  for (const key of LIMIT_KEYS) {
    const values = limitsList.map(l => l[key]).filter((v): v is number => v !== undefined);
    if (values.length === limitsList.length) result[key] = Math.min(...values);
  }
  return result;
};

const buildAliasedFrom = (alias: ModelAliasRecord): PublicModelAliasedFrom => ({
  name: alias.name,
  kind: alias.kind,
  selection: alias.selection,
  // Every configured target — including ones the live catalog can not
  // serve — so the dashboard can show the full configuration.
  targets: alias.targets,
});

// Compute the rule-aware intersection (`limits` + `chat`) over the
// alias's currently-available targets. Caller decides whether to use
// the result directly or overlay it under an operator override.
const computeAutomaticMetadata = (
  alias: ModelAliasRecord,
  availableTargets: readonly { target: AliasTarget; real: ResolvedModel }[],
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => {
  if (availableTargets.length === 0) return { limits: {}, chat: undefined };

  const limits = intersectLimits(availableTargets.map(({ real }) => real.limits));

  const effectiveChats = availableTargets
    .map(({ target, real }) => effectiveChatForIntersection(real.chat, target))
    .filter((c): c is ChatModelInfo => c !== undefined);
  // Intersect chat metadata only when every available target carries it
  // (post-downgrade); a half-declared block would leak the metadata of
  // whichever subset happened to carry it.
  const chat = effectiveChats.length === availableTargets.length
    ? intersectChat(effectiveChats)
    : undefined;

  return { limits, chat };
};

// Merge the operator's override on top of the computed payload, per the
// sparse-override contract: any sub-field the operator omitted falls
// back to the computed value for that sub-field.
const mergeWithOverride = (
  computed: { limits: PublicModelLimits; chat: ChatModelInfo | undefined },
  override: AnnouncedMetadata,
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => ({
  limits: override.limits ?? computed.limits,
  chat: override.chat ?? computed.chat,
});

const synthesizeOne = (alias: ModelAliasRecord, realModels: readonly ResolvedModel[]): PublicModel => {
  const realById = new Map(realModels.map(m => [m.id, m] as const));
  const availableTargets = alias.targets
    .map(target => ({ target, real: realById.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; real: ResolvedModel } => entry.real !== undefined && entry.real.kind === alias.kind);

  // Display name precedence: operator-set wins; otherwise derive from the
  // sole target's id + rules when single-target; multi-target falls back to
  // the alias's own name because no single target represents the alias.
  const displayName = alias.displayName ?? (alias.targets.length === 1
    ? composeAliasDisplayName(alias.targets[0].target_model_id, alias.targets[0].rules)
    : alias.name);

  const computed = computeAutomaticMetadata(alias, availableTargets);
  const { limits, chat } = alias.announcedMetadata !== null
    ? mergeWithOverride(computed, alias.announcedMetadata)
    : computed;

  const entry: PublicModel = {
    id: alias.name,
    object: 'model',
    type: 'model',
    display_name: displayName,
    limits,
    kind: alias.kind,
    aliasedFrom: buildAliasedFrom(alias),
  };
  if (chat !== undefined) entry.chat = chat;

  // Endpoints follow the available-targets intersection unconditionally
  // — the operator can't override them (the alias's reachable surface is
  // a fact derived from what the targets serve). Absent when no target
  // is currently available, same shape as the chat block.
  if (availableTargets.length > 0) {
    const endpoints = intersectEndpoints(availableTargets.map(({ real }) => real.endpoints));
    if (Object.keys(endpoints).length > 0) entry.endpoints = endpoints;
  }

  // Single-target chat pricing rides along when available — the resolver
  // will hit that target, so the catalog can publish its rate verbatim.
  if (availableTargets.length === 1) {
    const [{ real }] = availableTargets;
    if (real.cost !== undefined) entry.cost = real.cost;
  }

  return entry;
};

const sortAliases = (aliases: readonly ModelAliasRecord[]): ModelAliasRecord[] =>
  [...aliases].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

export const synthesizeListedAliases = (input: ListedAliasInputs): PublicModel[] =>
  sortAliases(input.aliases)
    .filter(alias => alias.visibleInModelsList)
    .map(alias => synthesizeOne(alias, input.realModels));

// Compose real-model entries with visible alias entries into a single typed
// list. Both data-plane `/v1/models` and the dashboard's `/api/models`
// share the same merge rule: when an alias's `name` collides with a real
// model id, the alias entry wins and the colliding real entry is dropped
// — two entries with the same `id` would break OpenAI-client deduplication,
// and the alias was added by the operator deliberately, so collapsing to
// it preserves intent. `mapReal` shapes each real model into the caller's
// row type; `wrapAlias` lifts a synthesized `PublicModel` alias entry into
// the same row type (the dashboard, for example, adds an empty `upstreams`
// array since alias rows do not bind to an upstream directly).
export const mergeAliasesIntoModels = <T extends PublicModel>(input: {
  readonly realModels: readonly ResolvedModel[];
  readonly aliases: readonly ModelAliasRecord[];
  readonly mapReal: (model: ResolvedModel) => T;
  readonly wrapAlias: (entry: PublicModel) => T;
}): T[] => {
  const { realModels, aliases, mapReal, wrapAlias } = input;
  const aliasEntries = synthesizeListedAliases({ aliases, realModels });
  const aliasIds = new Set(aliasEntries.map(entry => entry.id));
  return [
    ...realModels.filter(model => !aliasIds.has(model.id)).map(mapReal),
    ...aliasEntries.map(wrapAlias),
  ];
};
