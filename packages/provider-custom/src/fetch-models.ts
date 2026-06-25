// Custom-upstream /models response parser. Permissively accepts the three
// shapes our `custom` provider needs to interoperate with:
//   1. OpenAI:       { object: 'list', data: [{ id, object?, owned_by?, created? }] }
//   2. Anthropic:    { data: [{ type: 'model', id, display_name?, created_at? }],
//                      has_more, first_id, last_id }     (no top-level `object`)
//   3. OpenAI/Anthropic superset with optional display_name, created_at,
//      limits, cost, kind on the model and a `data` array on the container.
//
// A model is admitted if it has a string `id`; everything else is best-
// effort metadata. The container is admitted if `data` is an array.

import type { CustomUpstreamConfig } from './config.ts';
import { customFetchModels } from './fetch.ts';
import { BILLING_DIMENSIONS, type ModelKind, type ModelPricing } from '@floway-dev/protocols/common';
import { fetchUpstreamModels, type Fetcher } from '@floway-dev/provider';

export interface CustomRawModel {
  id: string;
  // OpenAI uses `created` (unix seconds). Anthropic uses `created_at`
  // (ISO-8601). We carry both and let the projection step decide.
  created?: number;
  created_at?: string;
  display_name?: string;
  // Non-standard OpenAI-compat alternative for the display name.
  name?: string;
  owned_by?: string;
  // Optional superset fields, absent on minimal OpenAI-compat upstreams.
  limits?: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  cost?: ModelPricing;
  // Optional ModelKind published by Floway upstreams; absent on plain
  // OpenAI-compat upstreams.
  kind?: ModelKind;
  // Optional chat metadata from Floway-shaped upstreams; absent on plain
  // OpenAI-compat upstreams.
  chat?: UpstreamChatModelConfig;
}

export interface CustomModelsResponse {
  data: CustomRawModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const parseLimits = (value: unknown): CustomRawModel['limits'] => {
  if (!isRecord(value)) return undefined;
  const limits: NonNullable<CustomRawModel['limits']> = {};
  const max_output_tokens = optionalNumberField(value.max_output_tokens);
  if (max_output_tokens !== undefined) limits.max_output_tokens = max_output_tokens;
  const max_context_window_tokens = optionalNumberField(value.max_context_window_tokens);
  if (max_context_window_tokens !== undefined) limits.max_context_window_tokens = max_context_window_tokens;
  const max_prompt_tokens = optionalNumberField(value.max_prompt_tokens);
  if (max_prompt_tokens !== undefined) limits.max_prompt_tokens = max_prompt_tokens;
  return Object.keys(limits).length > 0 ? limits : undefined;
};

const parseCost = (value: unknown): ModelPricing | undefined => {
  // Admit any subset of billing dimensions advertised on the upstream's
  // /v1/models cost block; drop the whole block when none are present.
  if (!isRecord(value)) return undefined;
  const cost: ModelPricing = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const rate = optionalNumberField(value[dimension]);
    if (rate !== undefined) cost[dimension] = rate;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
};

const parseKind = (value: unknown): ModelKind | undefined => {
  if (value === 'chat' || value === 'embedding' || value === 'image') return value;
  return undefined;
};

// Chat metadata types and parsing. Mirrored from the provider package's model-config.ts.
// These are defined locally here because custom provider is permissive about chat fields,
// treating them as best-effort metadata rather than structured configuration.

type Modality = 'text' | 'image';

interface UpstreamChatModelConfig {
  modalities?: {
    input: readonly Modality[];
    output: readonly Modality[];
  };
  reasoning?: {
    effort?: { supported: readonly string[]; default: string };
    budget_tokens?: { min?: number; max?: number };
    adaptive?: boolean;
    mandatory?: boolean;
  };
}

const MODALITY_VALUES: ReadonlySet<Modality> = new Set(['text', 'image']);

const modalityArrayField = (value: unknown): readonly Modality[] => {
  if (!Array.isArray(value)) throw new Error('must be an array');
  const out: Modality[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !MODALITY_VALUES.has(entry as Modality)) {
      throw new Error(`unknown modality ${JSON.stringify(entry)}`);
    }
    if (!out.includes(entry as Modality)) out.push(entry as Modality);
  }
  if (out.length === 0) throw new Error('must have at least one modality');
  return out;
};

const inputModalitiesField = (value: unknown): readonly Modality[] => {
  const modalities = modalityArrayField(value);
  if (!modalities.includes('text')) throw new Error('must include text');
  return modalities;
};

const parseChat = (value: unknown): UpstreamChatModelConfig | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('must be an object');
  const record = value as Record<string, unknown>;
  const out: UpstreamChatModelConfig = {};

  if (record.modalities !== undefined) {
    if (typeof record.modalities !== 'object' || record.modalities === null || Array.isArray(record.modalities)) {
      throw new Error('modalities must be an object');
    }
    const mod = record.modalities as Record<string, unknown>;
    out.modalities = {
      input: inputModalitiesField(mod.input),
      output: modalityArrayField(mod.output),
    };
  }

  if (record.reasoning !== undefined) {
    if (typeof record.reasoning !== 'object' || record.reasoning === null || Array.isArray(record.reasoning)) {
      throw new Error('reasoning must be an object');
    }
    const reasoning = record.reasoning as Record<string, unknown>;
    const result: NonNullable<UpstreamChatModelConfig['reasoning']> = {};

    if (reasoning.effort !== undefined) {
      if (typeof reasoning.effort !== 'object' || reasoning.effort === null || Array.isArray(reasoning.effort)) {
        throw new Error('effort must be an object');
      }
      const effort = reasoning.effort as Record<string, unknown>;
      if (!Array.isArray(effort.supported)) throw new Error('effort.supported must be an array');
      const supported: string[] = [];
      for (const eff of effort.supported) {
        if (typeof eff !== 'string' || eff.length === 0) throw new Error('effort.supported must contain non-empty strings');
        if (!supported.includes(eff)) supported.push(eff);
      }
      if (supported.length === 0) throw new Error('effort.supported must have at least one entry');
      if (typeof effort.default !== 'string' || effort.default.length === 0) {
        throw new Error('effort.default must be a non-empty string');
      }
      if (!supported.includes(effort.default)) {
        throw new Error(`effort.default not in effort.supported`);
      }
      result.effort = { supported, default: effort.default };
    }

    if (reasoning.budget_tokens !== undefined) {
      if (typeof reasoning.budget_tokens !== 'object' || reasoning.budget_tokens === null || Array.isArray(reasoning.budget_tokens)) {
        throw new Error('budget_tokens must be an object');
      }
      const bt = reasoning.budget_tokens as Record<string, unknown>;
      const min = (typeof bt.min === 'number' && Number.isInteger(bt.min) && bt.min >= 0) ? bt.min : undefined;
      const max = (typeof bt.max === 'number' && Number.isInteger(bt.max) && bt.max >= 0) ? bt.max : undefined;
      if (min !== undefined && max !== undefined && max < min) {
        throw new Error('budget_tokens.max must be >= min');
      }
      result.budget_tokens = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }

    if (reasoning.adaptive !== undefined) {
      if (typeof reasoning.adaptive !== 'boolean') throw new Error('adaptive must be a boolean');
      if (reasoning.adaptive) result.adaptive = true;
    }

    if (reasoning.mandatory !== undefined) {
      if (typeof reasoning.mandatory !== 'boolean') throw new Error('mandatory must be a boolean');
      if (reasoning.mandatory) result.mandatory = true;
    }

    if (!result.effort && !result.budget_tokens && !result.adaptive && !result.mandatory) {
      throw new Error('reasoning must have at least one of effort, budget_tokens, adaptive, mandatory');
    }

    out.reasoning = result;
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const parseRawModel = (value: unknown): CustomRawModel | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  const model: CustomRawModel = { id: value.id };
  const created = optionalNumberField(value.created);
  if (created !== undefined) model.created = created;
  const created_at = optionalStringField(value.created_at);
  if (created_at !== undefined) model.created_at = created_at;
  const display_name = optionalStringField(value.display_name);
  if (display_name !== undefined) model.display_name = display_name;
  const name = optionalStringField(value.name);
  if (name !== undefined) model.name = name;
  const owned_by = optionalStringField(value.owned_by);
  if (owned_by !== undefined) model.owned_by = owned_by;
  const limits = parseLimits(value.limits);
  if (limits !== undefined) model.limits = limits;
  const cost = parseCost(value.cost);
  if (cost !== undefined) model.cost = cost;
  const kind = parseKind(value.kind);
  if (kind !== undefined) model.kind = kind;
  // Attempt to parse chat metadata; silently skip on malformed data.
  try {
    const chat = parseChat(value.chat);
    if (chat !== undefined) model.chat = chat;
  } catch {
    // Permissive: if chat field is malformed, skip it and continue.
  }
  return model;
};

const parseCustomModelsResponse = (value: unknown): CustomModelsResponse | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const data: CustomRawModel[] = [];
  for (const item of value.data) {
    const model = parseRawModel(item);
    if (model) data.push(model);
  }
  return { data };
};

export const fetchCustomModels = (config: CustomUpstreamConfig, fetcher: Fetcher): Promise<CustomModelsResponse> =>
  fetchUpstreamModels(
    () => customFetchModels(config, { method: 'GET' }, { fetcher }),
    parseCustomModelsResponse,
  );
