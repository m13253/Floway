// Ollama catalog discovery. Ollama exposes two relevant endpoints:
//   GET  /api/tags          → enumerates installed/hosted models with a
//                             short metadata blob ({name, modified_at, ...}).
//                             The cloud variant leaves the `details` sub-object
//                             empty, so this call alone does not reveal model
//                             capabilities or context length.
//   POST /api/show {name}   → returns the per-model `capabilities` array
//                             (`completion`/`tools`/`thinking`/`vision`/
//                             `embedding`) and the `model_info` map (keyed by
//                             a varying-per-architecture prefix that carries
//                             `<arch>.context_length` and
//                             `<arch>.embedding_length`).
//
// We fan out one /api/show per tag in parallel and synthesize the per-model
// shape the gateway consumes. /api/show calls are independent and read-only;
// a single failure drops just that model from the catalog rather than
// poisoning the whole list.
//
// /api/embeddings (legacy) is not used — the modern Ollama embedding path is
// /api/embed for native callers and /v1/embeddings for the OpenAI shim.

import type { OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchShow, ollamaFetchTags } from './fetch.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface OllamaRawModel {
  // The slug Ollama uses everywhere (e.g. `gpt-oss:120b`, `deepseek-v4-flash`,
  // `nomic-embed-text:latest`). This is the value the gateway sends back to
  // Ollama as the `model` field on every inference call.
  id: string;
  modifiedAt?: number;
  capabilities: ReadonlySet<string>;
  contextLength?: number;
  embeddingLength?: number;
  family?: string;
  architecture?: string;
  parameterCount?: number;
  quantizationLevel?: string;
}

export interface OllamaCatalog {
  data: OllamaRawModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

interface TagEntry {
  name: string;
  modifiedAt?: number;
}

const parseTagEntry = (value: unknown): TagEntry | null => {
  if (!isRecord(value)) return null;
  // Ollama publishes the slug under `name`; older releases used `model` —
  // accept either, preferring `name` when both are present.
  const name = optionalStringField(value.name) ?? optionalStringField(value.model);
  if (!name) return null;
  const entry: TagEntry = { name };
  const modifiedAtRaw = optionalStringField(value.modified_at);
  if (modifiedAtRaw) {
    const ms = Date.parse(modifiedAtRaw);
    if (!Number.isNaN(ms)) entry.modifiedAt = Math.floor(ms / 1000);
  }
  return entry;
};

const parseTagsResponse = (value: unknown): TagEntry[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  const entries: TagEntry[] = [];
  for (const item of value.models) {
    const entry = parseTagEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
};

// model_info keys are prefixed by the architecture identifier the GGUF
// publishes (e.g. `gptoss.context_length`, `qwen3moe.context_length`,
// `kimi-k2.context_length`). The prefix varies per family — sometimes it
// includes a hyphen, sometimes a digit — so consumers must enumerate the keys
// rather than hardcoding the prefix. We pick the first hit ending in the
// requested suffix.
const findArchSuffixedNumber = (modelInfo: Record<string, unknown>, suffix: string): number | undefined => {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(suffix)) {
      const n = optionalNumberField(value);
      if (n !== undefined && n > 0) return n;
    }
  }
  return undefined;
};

const parseShowResponse = (id: string, modifiedAt: number | undefined, value: unknown): OllamaRawModel | null => {
  if (!isRecord(value)) return null;

  const capabilities = new Set<string>();
  if (Array.isArray(value.capabilities)) {
    for (const cap of value.capabilities) {
      if (typeof cap === 'string' && cap !== '') capabilities.add(cap);
    }
  }

  const details = isRecord(value.details) ? value.details : null;
  const modelInfo = isRecord(value.model_info) ? value.model_info : null;

  const raw: OllamaRawModel = { id, capabilities };
  if (modifiedAt !== undefined) raw.modifiedAt = modifiedAt;
  if (details) {
    const family = optionalStringField(details.family);
    if (family) raw.family = family;
    const quant = optionalStringField(details.quantization_level);
    if (quant) raw.quantizationLevel = quant;
  }
  if (modelInfo) {
    const architecture = optionalStringField(modelInfo['general.architecture']);
    if (architecture) raw.architecture = architecture;
    const paramCount = optionalNumberField(modelInfo['general.parameter_count']);
    if (paramCount !== undefined && paramCount > 0) raw.parameterCount = paramCount;
    const contextLength = findArchSuffixedNumber(modelInfo, '.context_length');
    if (contextLength !== undefined) raw.contextLength = contextLength;
    const embeddingLength = findArchSuffixedNumber(modelInfo, '.embedding_length');
    if (embeddingLength !== undefined) raw.embeddingLength = embeddingLength;
  }

  return raw;
};

const fetchShowForTag = async (
  config: OllamaUpstreamConfig,
  fetcher: Fetcher,
  tag: TagEntry,
): Promise<OllamaRawModel | null> => {
  const response = await ollamaFetchShow(
    config,
    { method: 'POST', body: JSON.stringify({ name: tag.name }) },
    { fetcher },
  );
  if (!response.ok) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  return parseShowResponse(tag.name, tag.modifiedAt, parsed);
};

export const fetchOllamaCatalog = async (config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaCatalog> => {
  const tagsResponse = await ollamaFetchTags(config, { method: 'GET' }, { fetcher });
  if (!tagsResponse.ok) {
    throw new Error(`Ollama /api/tags fetch failed: ${tagsResponse.status} ${await tagsResponse.text().then(t => t.slice(0, 200)).catch(() => '')}`);
  }
  const tags = parseTagsResponse(await tagsResponse.json());
  // Fan out /api/show calls in parallel. allSettled keeps a single per-model
  // failure from dropping the whole catalog; a rejected entry just falls out.
  const settled = await Promise.allSettled(tags.map(tag => fetchShowForTag(config, fetcher, tag)));
  const data: OllamaRawModel[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value !== null) data.push(result.value);
  }
  return { data };
};
