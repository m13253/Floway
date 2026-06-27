// Synthesizes the alias entries that join the real-model catalog inside
// `/v1/models`. One PublicModel per visible alias. The synthesized entry
// carries an `aliasedFrom` block so an alias-aware UI can render the
// alias-of relationship without a second round trip.
//
// `limits` and `chat` come from the alias's announced metadata payload:
// the operator's stored override when set (with top-level sub-block
// granularity — a present `limits` / `chat` replaces the computed
// counterpart wholesale, not per-leaf), otherwise the rule-aware
// intersection across the alias's available targets. The
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
import type { AddressableIdEntry } from '../providers/addressable.ts';
import { unionEndpoints } from '../providers/endpoint-union.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import type { AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, PublicModel, PublicModelAliasedFrom, PublicModelLimits } from '@floway-dev/protocols/common';
import type { ResolvedModel } from '@floway-dev/provider';

export interface ListedAliasInputs {
  readonly aliases: readonly ModelAliasRecord[];
  // Full addressable surface — both the listed catalog rows and the
  // addressable-but-not-listed prefix/redirect forms each provider
  // contributes. The synthesizer maps every alias target through this
  // surface so a target that's only reachable via a prefix alternate or
  // Copilot variant id still counts as available.
  readonly addressableModelIds: readonly AddressableIdEntry[];
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
    // Both halves must survive — an alias that consumes a modality but
    // promises no output (or the inverse) is incoherent. Omit the block
    // entirely when either intersection collapses.
    if (input.length > 0 && output.length > 0) result.modalities = { input, output };
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
      // Require BOTH min and max to be all-declared, mirroring how
      // `effort`, `adaptive`, and `mandatory` all collapse the moment one
      // target leaves a leaf undeclared. A half-declared block (e.g.
      // `{ min }` with no max) would advertise a capability some target
      // does not actually report.
      if (mins.length === budgetChats.length && maxes.length === budgetChats.length) {
        const min = Math.max(...mins);
        const max = Math.min(...maxes);
        // Drop the budget block when the intersected window is empty —
        // a contradictory range is worse than no advertisement.
        if (min <= max) reasoning.budget_tokens = { min, max };
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
  availableTargets: readonly { target: AliasTarget; real: ResolvedModel }[],
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => {
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

// Merge the operator's override on top of the computed payload at the
// top-level sub-block boundary: a present `limits` / `chat` on the
// override replaces the computed counterpart wholesale; an omitted
// sub-block falls back to the computed value. (Merge is intentionally
// NOT per-leaf — that's the contract `AnnouncedMetadata` advertises.)
const mergeWithOverride = (
  computed: { limits: PublicModelLimits; chat: ChatModelInfo | undefined },
  override: AnnouncedMetadata,
): { limits: PublicModelLimits; chat: ChatModelInfo | undefined } => ({
  limits: override.limits ?? computed.limits,
  chat: override.chat ?? computed.chat,
});

// Returns null when every configured target falls outside the caller's
// addressable surface — an alias with no reachable target has no listing
// row, because the catalog should never advertise an id the resolver
// would 404 on. The alias itself stays addressable through
// `resolveAlias`, which surfaces `AliasNoTargetAvailableError` at request
// time. Callers (`synthesizeListedAliases`) filter the nulls out.
const synthesizeOne = (alias: ModelAliasRecord, addressableModelIds: readonly AddressableIdEntry[]): PublicModel | null => {
  // Map every alias target through the full addressable surface, not just
  // the listed catalog: a target reachable only via a prefix-addressable
  // alternate or a provider-side redirect (Copilot variant id) is still
  // available to the resolver, and the listing must agree.
  const addressableById = new Map(addressableModelIds.map(entry => [entry.id, entry.model] as const));
  const availableTargets = alias.targets
    .map(target => ({ target, real: addressableById.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; real: ResolvedModel } => entry.real !== undefined && entry.real.kind === alias.kind);

  if (availableTargets.length === 0) return null;

  // Display name precedence: operator-set wins; otherwise derive from the
  // sole target's id + rules when single-target; multi-target falls back to
  // the alias's own name because no single target represents the alias.
  const displayName = alias.displayName ?? (alias.targets.length === 1
    ? composeAliasDisplayName(alias.targets[0].target_model_id, alias.targets[0].rules)
    : alias.name);

  const computed = computeAutomaticMetadata(availableTargets);
  const { limits, chat } = alias.announcedMetadata !== null
    ? mergeWithOverride(computed, alias.announcedMetadata)
    : computed;

  // Endpoints follow the available-targets UNION, not an intersection —
  // every endpoint reachable through ANY target is advertised, because
  // the resolver's request-time pool narrows to targets that serve the
  // inbound endpoint and the first-available / random pick happens
  // within that narrowed pool. Operator can't override endpoints (they
  // follow the target set, not a stored override).
  const endpoints = unionEndpoints(availableTargets.map(({ real }) => real.endpoints));

  const entry: PublicModel = {
    id: alias.name,
    object: 'model',
    type: 'model',
    display_name: displayName,
    limits,
    kind: alias.kind,
    endpoints,
    aliasedFrom: buildAliasedFrom(alias),
  };
  if (chat !== undefined) entry.chat = chat;

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
    .map(alias => synthesizeOne(alias, input.addressableModelIds))
    .filter((entry): entry is PublicModel => entry !== null);

// Compose real-model entries with visible alias entries into a single typed
// list. Both data-plane `/v1/models` and the dashboard's `/api/models`
// share the same merge rule: when an alias's `name` collides with a real
// model id, the alias entry wins and the colliding real entry is dropped
// — two entries with the same `id` would break OpenAI-client deduplication,
// and the alias was added by the operator deliberately, so collapsing to
// it preserves intent. `mapReal` shapes each real model into the caller's
// row type; `wrapAlias` lifts a synthesized `PublicModel` alias entry into
// the same row type (the dashboard, for example, adds an empty `upstreams`
// array since alias rows do not bind to an upstream directly; the Gemini
// `/v1beta/models` route maps into the upstream's `InternalModel` shape
// before projecting to Gemini's wire form).
//
// `realModels` is the listed projection — what `/v1/models` and the
// dashboard's default `/api/models` row stream emit. `addressableModelIds`
// feeds the alias synthesizer's availability check; the merge step never
// promotes addressable-but-not-listed ids to real-model rows.
export const mergeAliasesIntoModels = <T>(input: {
  readonly realModels: readonly ResolvedModel[];
  readonly addressableModelIds: readonly AddressableIdEntry[];
  readonly aliases: readonly ModelAliasRecord[];
  readonly mapReal: (model: ResolvedModel) => T;
  readonly wrapAlias: (entry: PublicModel) => T;
}): T[] => {
  const { realModels, addressableModelIds, aliases, mapReal, wrapAlias } = input;
  const aliasEntries = synthesizeListedAliases({ aliases, addressableModelIds });
  const aliasIds = new Set(aliasEntries.map(entry => entry.id));
  return [
    ...realModels.filter(model => !aliasIds.has(model.id)).map(mapReal),
    ...aliasEntries.map(wrapAlias),
  ];
};
