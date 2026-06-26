// Shared catalog lookups + warning computation for the alias dashboard
// surfaces (Settings row, edit dialog, target row). Centralising these
// helpers means the Settings card and the dialog read the same view of the
// live /api/models catalog — both the "is this id a real (non-alias) model"
// and "does this target's chat capability advertise <X>" checks resolve
// against one source of truth instead of two parallel implementations.

import type { ChatAliasRules, ControlPlaneModel, ModelAlias } from '../../api/types.ts';

// A target id matches a catalog model when either form (prefixed or
// unprefixed) resolves to that public id. The /api/models catalog already
// emits the public id directly, so equality is enough; future prefix-form
// surfaces can wire their normalisation in here without touching the
// callers. Alias entries are excluded — at runtime target ids never
// re-enter the alias layer, so the rule-warning lookup must compare against
// the same "real model" surface the suggestion list and shadow-detection
// helpers already use.
export const findCatalogModel = (
  models: readonly ControlPlaneModel[] | null | undefined,
  targetModelId: string,
): ControlPlaneModel | undefined =>
  (models ?? []).find(m => m.id === targetModelId && m.aliasedFrom === undefined);

// Real (non-alias) model ids the operator can route to. Used by the
// target-id combobox suggestion list and by the shadow-warning check.
export const realModelIds = (models: readonly ControlPlaneModel[] | null | undefined): string[] =>
  (models ?? []).filter(m => m.aliasedFrom === undefined).map(m => m.id);

// One warning attached to a specific chat rule field. The field key matches
// the form's `data-field` attribute so the dialog can render the warning
// directly under the input it annotates.
export interface AliasRuleWarning {
  field: 'reasoning.effort' | 'reasoning.budget_tokens' | 'reasoning.adaptive' | 'reasoning.summary' | 'reasoning.mandatory' | 'verbosity' | 'serviceTier';
  message: string;
}

// Rule-level warnings: a configured rule field whose target's chat
// capability metadata does not advertise the feature. The gateway still
// forwards the value verbatim; the warning just tells the operator the
// upstream may ignore it.
export const computeRuleWarnings = (
  rules: ChatAliasRules,
  catalog: ControlPlaneModel | undefined,
): AliasRuleWarning[] => {
  const out: AliasRuleWarning[] = [];
  const chat = catalog?.chat;
  const reasoning = chat?.reasoning;

  if (rules.reasoning?.effort !== undefined) {
    const supported = reasoning?.effort?.supported;
    if (supported === undefined) {
      out.push({ field: 'reasoning.effort', message: 'Target does not advertise reasoning effort.' });
    } else if (!supported.includes(rules.reasoning.effort)) {
      out.push({ field: 'reasoning.effort', message: `Target advertises effort levels: ${supported.join(', ')}.` });
    }
  }

  if (rules.reasoning?.budget_tokens !== undefined) {
    const range = reasoning?.budget_tokens;
    if (range === undefined) {
      out.push({ field: 'reasoning.budget_tokens', message: 'Target does not advertise a reasoning budget.' });
    } else {
      const n = rules.reasoning.budget_tokens;
      if (range.min !== undefined && n < range.min) out.push({ field: 'reasoning.budget_tokens', message: `Below target minimum (${range.min}).` });
      if (range.max !== undefined && n > range.max) out.push({ field: 'reasoning.budget_tokens', message: `Above target maximum (${range.max}).` });
    }
  }

  if (rules.reasoning?.adaptive === true && reasoning?.adaptive !== true) {
    out.push({ field: 'reasoning.adaptive', message: 'Target does not advertise adaptive reasoning.' });
  }

  if (rules.reasoning?.mandatory === true && reasoning?.mandatory !== true) {
    out.push({ field: 'reasoning.mandatory', message: 'Target does not advertise mandatory reasoning.' });
  }

  // Summary, verbosity, and serviceTier have no advertised catalog metadata
  // today; their values are forwarded verbatim and never warn here.

  return out;
};

// One model-level warning attached to one target row. Today the only
// trigger is the target id failing to resolve to any catalog model — the
// dashboard surfaces it via a yellow `!` icon in the row's action cluster
// with a tooltip listing every warning on that row.
export interface AliasModelWarning {
  message: string;
}

export const computeModelWarnings = (
  targetModelId: string,
  catalog: ControlPlaneModel | undefined,
): AliasModelWarning[] => {
  if (targetModelId === '') return [];
  if (catalog === undefined) {
    return [{ message: `"${targetModelId}" does not currently resolve to any enabled upstream binding.` }];
  }
  return [];
};

// Alias-level shadow warning. Fires iff the alias name matches a real
// (non-alias) catalog model id AND no target inside the alias references
// that real id (the seed pattern — alias name = first target's id —
// deliberately suppresses the warning).
export interface AliasShadowWarning {
  shadowedId: string;
  shadowedDisplayName: string | null;
}

export const computeShadowWarning = (
  aliasName: string,
  targets: readonly { target_model_id: string }[],
  models: readonly ControlPlaneModel[] | null | undefined,
): AliasShadowWarning | null => {
  if (aliasName === '') return null;
  const shadowed = (models ?? []).find(m => m.id === aliasName && m.aliasedFrom === undefined);
  if (!shadowed) return null;
  if (targets.some(t => t.target_model_id === aliasName)) return null;
  const displayName = shadowed.display_name ?? null;
  return {
    shadowedId: shadowed.id,
    shadowedDisplayName: displayName !== null && displayName !== shadowed.id ? displayName : null,
  };
};

// Convenience wrapper for the Settings row: derive whether this alias
// trips the shadow warning against the live catalog.
export const aliasHasShadowWarning = (
  alias: ModelAlias,
  models: readonly ControlPlaneModel[] | null | undefined,
): boolean => computeShadowWarning(alias.name, alias.targets, models) !== null;
