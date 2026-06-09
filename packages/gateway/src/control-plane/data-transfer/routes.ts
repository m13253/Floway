// Data transfer routes — export/import operator-managed database data as JSON.
// Ephemeral stored Responses state is omitted from exports and cleared on
// replace imports; clients can regenerate it through normal Responses use.
//
// The export contains every credential the gateway holds — provider API keys,
// GitHub tokens, Codex refresh tokens, and proxy URIs that embed passwords /
// UUIDs / PSKs. The endpoint is admin-only via x-api-key; operators are
// responsible for handling the dumped file with the same care as a DB backup.

import { parseSearchConfigDefault, parseSearchConfigStrict } from '../../data-plane/tools/web-search/search-config.ts';
import type { SearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { parseDisabledPublicModelIdsWire } from '../../repo/disabled-public-models.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_PROXY_ID, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import type { ApiKey, PerformanceMetricScope, PerformanceTelemetryRecord, ProxyRecord, SearchUsageRecord, TokenUsage, UsageRecord } from '../../repo/types.ts';
import { isWebSearchProviderName } from '../../shared/web-search-providers.ts';
import { parseUpstreamIdsValue } from '../api-keys/upstream-ids.ts';
import type { exportQuery, importBody } from '../schemas.ts';
import { type SerializedUpstreamRecord, upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { BillingDimension, ModelPricing } from '@floway-dev/protocols/common';
import { invalidateModelsStore, parseFlagOverridesWire } from '@floway-dev/provider';
import type { PerformanceApiName, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import { assertCodexUpstreamRecord, assertCodexUpstreamState } from '@floway-dev/provider-codex';
import { isCopilotAccountType } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { parseProxyUri } from '@floway-dev/proxy';

// Wire shape of a proxy entry in the export/import payload. The runtime
// observation fields (last_egress_ip, last_tested_at) and the backoff rows
// are deliberately excluded — they describe what this deployment saw, not
// what the operator configured.
interface SerializedProxy {
  id: string;
  name: string;
  url: string;
  sort_order: number;
  dial_timeout_seconds: number | null;
}

interface ExportPayload {
  version: 3;
  exportedAt: string;
  data: {
    apiKeys: ApiKey[];
    upstreams: SerializedUpstreamRecord[];
    proxies: SerializedProxy[];
    usage: UsageRecord[];
    searchUsage: SearchUsageRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded: boolean;
    searchConfig: SearchConfig;
  };
}

const EXPORT_VERSION = 3;
const SEARCH_USAGE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const PERFORMANCE_METRIC_SCOPES = new Set<PerformanceMetricScope>(['request_total', 'upstream_success']);
const PERFORMANCE_API_NAMES = new Set<PerformanceApiName>(['messages', 'responses', 'chat-completions', 'gemini', 'embeddings', 'images_generations', 'images_edits']);
const UPSTREAM_PROVIDERS = new Set<UpstreamProviderKind>(['custom', 'azure', 'copilot', 'codex']);
const LEGACY_UPSTREAM_PREFIXES = ['openai:', 'copilot:'];

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isLegacyUpstreamIdentity = (value: string): boolean => LEGACY_UPSTREAM_PREFIXES.some(prefix => value.startsWith(prefix));

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
};

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

const nullableStringField = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new Error(`${field} must be a string or null`);
  return value;
};

const safeIntegerField = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
};

const copilotConfigField = (value: unknown): unknown => {
  if (!isRecord(value)) throw new Error('config must be an object');
  if (!isCopilotAccountType(value.accountType)) throw new Error('config.accountType must be one of individual, business, enterprise');
  if (!isRecord(value.user)) throw new Error('config.user must be an object');
  return {
    githubToken: nonEmptyString(value.githubToken, 'config.githubToken'),
    accountType: value.accountType,
    user: {
      login: stringField(value.user.login, 'config.user.login'),
      avatar_url: stringField(value.user.avatar_url, 'config.user.avatar_url'),
      name: nullableStringField(value.user.name, 'config.user.name'),
      id: safeIntegerField(value.user.id, 'config.user.id'),
    },
  };
};

const normalizeUpstreamConfig = (record: UpstreamRecord): unknown => {
  if (record.provider === 'custom') return assertCustomUpstreamRecord(record).config;
  if (record.provider === 'azure') return assertAzureUpstreamRecord(record).config;
  if (record.provider === 'codex') {
    assertCodexUpstreamRecord(record);
    return record.config;
  }
  return copilotConfigField(record.config);
};

// State is persisted only for providers that own autonomous runtime state. Codex
// rotates a refresh_token and tracks credential health; Custom/Azure/Copilot
// have no such state and serialize to null. Round-trip codex state through
// the same shape assertion the runtime uses so a corrupt or hand-edited
// import can't smuggle unknown fields onto the column.
const normalizeUpstreamState = (provider: UpstreamProviderKind, value: unknown): unknown => {
  if (provider !== 'codex') return null;
  if (value === null || value === undefined) {
    throw new Error('codex upstream import is missing state — re-export with current code');
  }
  assertCodexUpstreamState(value);
  return value;
};

const parseProxyFallbackListField = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('proxy_fallback_list must be an array');
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('proxy_fallback_list entries must be strings');
  }
  return normalizeProxyFallbackList(value as string[]);
};

const parseUpstreamRecords = (value: unknown): { type: 'ok'; records: UpstreamRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'upstreams must be an array' };

  const records: UpstreamRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    try {
      const item = value[i];
      if (!isRecord(item)) throw new Error('record must be an object');
      if (hasOwn(item, 'enabled_fixes')) {
        throw new Error("legacy 'enabled_fixes' field is no longer supported; this export predates the flag_overrides refactor — re-export with current code");
      }
      if (typeof item.provider !== 'string' || !UPSTREAM_PROVIDERS.has(item.provider as UpstreamProviderKind)) {
        throw new Error('provider must be one of custom, azure, copilot, codex');
      }
      if (typeof item.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      if (typeof item.sort_order !== 'number' || !Number.isFinite(item.sort_order)) throw new Error('sort_order must be a finite number');

      const id = nonEmptyString(item.id, 'id');
      if (isLegacyUpstreamIdentity(id)) throw new Error('id must use a raw upstream id, not a legacy provider-prefixed identity');

      const provider = item.provider as UpstreamProviderKind;
      const record: UpstreamRecord = {
        id,
        provider,
        name: nonEmptyString(item.name, 'name'),
        enabled: item.enabled,
        sortOrder: Math.floor(item.sort_order),
        createdAt: nonEmptyString(item.created_at, 'created_at'),
        updatedAt: nonEmptyString(item.updated_at, 'updated_at'),
        flagOverrides: parseFlagOverridesWire(item.flag_overrides),
        disabledPublicModelIds: parseDisabledPublicModelIdsWire(item.disabled_public_model_ids),
        proxyFallbackList: parseProxyFallbackListField(item.proxy_fallback_list),
        config: item.config,
        state: normalizeUpstreamState(provider, item.state),
      };
      records.push({ ...record, config: normalizeUpstreamConfig(record) });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const parseProxyRecords = (value: unknown): { type: 'ok'; records: SerializedProxy[] } | { type: 'invalid'; index: number; error: string } => {
  // Proxies are optional in the import contract: an absent or empty array
  // means "the source deployment had no proxies". The cross-reference check
  // later still fails the import if upstreams point at ids this array
  // doesn't carry, so a dangling reference cannot slip through silently.
  if (value === undefined) return { type: 'ok', records: [] };
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'proxies must be an array' };

  const records: SerializedProxy[] = [];
  for (let i = 0; i < value.length; i++) {
    try {
      const item = value[i];
      if (!isRecord(item)) throw new Error('record must be an object');
      const id = nonEmptyString(item.id, 'id');
      if (id === DIRECT_PROXY_ID) throw new Error(`id must not be the reserved '${DIRECT_PROXY_ID}' sentinel`);
      const name = nonEmptyString(item.name, 'name');
      const url = nonEmptyString(item.url, 'url');
      try {
        parseProxyUri(url);
      } catch (err) {
        throw new Error(`url did not parse: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (typeof item.sort_order !== 'number' || !Number.isFinite(item.sort_order)) throw new Error('sort_order must be a finite number');
      const dialTimeoutSeconds = item.dial_timeout_seconds;
      if (dialTimeoutSeconds !== null && (typeof dialTimeoutSeconds !== 'number' || !Number.isInteger(dialTimeoutSeconds) || dialTimeoutSeconds < 1)) {
        throw new Error('dial_timeout_seconds must be null or a positive integer');
      }
      records.push({ id, name, url, sort_order: Math.floor(item.sort_order), dial_timeout_seconds: dialTimeoutSeconds });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const validateProxyIdentities = (records: readonly SerializedProxy[]): string | null => {
  const seen = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const prior = seen.get(records[i].id);
    if (prior !== undefined) return `duplicate proxies id ${records[i].id} at indexes ${prior} and ${i}`;
    seen.set(records[i].id, i);
  }
  return null;
};

// Every entry in every upstream's proxy_fallback_list must resolve to either
// an imported proxy id or the 'direct' sentinel. A dangling reference would
// silently disable that fallback in the dial layer, which is exactly the
// silent-truncation behavior the import contract is supposed to prevent.
const validateProxyFallbackReferences = (upstreams: readonly UpstreamRecord[], proxies: readonly SerializedProxy[]): string | null => {
  const knownIds = new Set<string>(proxies.map(p => p.id));
  knownIds.add(DIRECT_PROXY_ID);
  for (const upstream of upstreams) {
    for (const ref of upstream.proxyFallbackList) {
      if (!knownIds.has(ref)) {
        return `upstream ${upstream.id} references unknown proxy ${ref}`;
      }
    }
  }
  return null;
};

const parseApiKeyRecords = (value: unknown): { type: 'ok'; records: ApiKey[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'apiKeys must be an array' };

  const records: ApiKey[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!isRecord(record)) return { type: 'invalid', index: i, error: 'record must be an object' };
    // Older exports omit the field; treat as Default.
    const upstreamIdsRaw = record.upstreamIds === undefined ? null : record.upstreamIds;
    const upstreamIdsParsed = parseUpstreamIdsValue(upstreamIdsRaw);
    if (!upstreamIdsParsed.ok) return { type: 'invalid', index: i, error: upstreamIdsParsed.error };
    try {
      records.push({
        id: nonEmptyString(record.id, 'id'),
        name: nonEmptyString(record.name, 'name'),
        key: nonEmptyString(record.key, 'key'),
        createdAt: nonEmptyString(record.createdAt, 'createdAt'),
        ...(record.lastUsedAt !== undefined ? { lastUsedAt: nonEmptyString(record.lastUsedAt, 'lastUsedAt') } : {}),
        upstreamIds: upstreamIdsParsed.value,
      });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const validateApiKeyIdentities = (records: readonly ApiKey[], existing: readonly ApiKey[], mode: string): string | null => {
  const ids = new Map<string, number>();
  const rawKeys = new Map<string, string>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const existingIdIndex = ids.get(record.id);
    if (existingIdIndex !== undefined) return `duplicate apiKeys id ${record.id} at indexes ${existingIdIndex} and ${i}`;
    ids.set(record.id, i);

    const existingRawKeyId = rawKeys.get(record.key);
    if (existingRawKeyId !== undefined) return `duplicate apiKeys raw key used by ${existingRawKeyId} and ${record.id}`;
    rawKeys.set(record.key, record.id);
  }

  if (mode === 'merge') {
    const existingRawKeys = new Map(existing.map(record => [record.key, record.id]));
    for (const record of records) {
      const existingId = existingRawKeys.get(record.key);
      if (existingId !== undefined && existingId !== record.id) {
        return `apiKeys raw key for ${record.id} conflicts with existing api key ${existingId}`;
      }
    }
  }

  return null;
};

const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

const parseImportedCost = (value: unknown): UsageRecord['cost'] => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const cost: ModelPricing = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const rate = obj[dimension];
    if (typeof rate === 'number') cost[dimension] = rate;
  }
  return Object.keys(cost).length > 0 ? cost : null;
};

const parseImportedTokens = (value: unknown): { type: 'ok'; tokens: TokenUsage } | { type: 'invalid' } => {
  if (value === undefined || value === null) return { type: 'ok', tokens: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { type: 'invalid' };
  const obj = value as Record<string, unknown>;
  const tokens: TokenUsage = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const count = obj[dimension];
    if (count === undefined) continue;
    if (!isNonNegativeSafeInteger(count)) return { type: 'invalid' };
    if (count > 0) tokens[dimension] = count;
  }
  return { type: 'ok', tokens };
};

const parseUsageRecords = (value: unknown): { type: 'ok'; records: UsageRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'usage must be an array' };

  const records: UsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!isRecord(record)) return { type: 'invalid', index: i, error: 'record must be an object' };
    if (
      typeof record.keyId !== 'string' ||
      record.keyId.length === 0 ||
      typeof record.model !== 'string' ||
      record.model.length === 0 ||
      (record.upstream !== null && typeof record.upstream !== 'string') ||
      typeof record.modelKey !== 'string' ||
      record.modelKey.length === 0 ||
      typeof record.hour !== 'string' ||
      !SEARCH_USAGE_HOUR_PATTERN.test(record.hour) ||
      !isNonNegativeSafeInteger(record.requests)
    ) {
      return { type: 'invalid', index: i, error: 'record has invalid usage fields' };
    }
    if (typeof record.upstream === 'string' && isLegacyUpstreamIdentity(record.upstream)) {
      return { type: 'invalid', index: i, error: 'upstream must use a raw upstream id, not a legacy provider-prefixed identity' };
    }
    const tokensResult = parseImportedTokens(record.tokens);
    if (tokensResult.type === 'invalid') return { type: 'invalid', index: i, error: 'record has invalid token dimension counts' };
    records.push({
      keyId: record.keyId,
      model: record.model,
      upstream: record.upstream as string | null,
      modelKey: record.modelKey,
      hour: record.hour,
      requests: record.requests,
      tokens: tokensResult.tokens,
      // Imported payloads may omit cost (older exports) — null is the
      // canonical "no pricing recorded" value; aggregation treats it as 0.
      cost: parseImportedCost(record.cost),
    });
  }

  return { type: 'ok', records };
};

const parseSearchUsageRecords = (value: unknown): { type: 'ok'; records: SearchUsageRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'searchUsage must be an array' };

  const records: SearchUsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== 'object') return { type: 'invalid', index: i, error: 'record must be an object' };

    const item = record as Record<string, unknown>;
    const provider = item.provider;
    const keyId = item.keyId;
    const action = item.action;
    const hour = item.hour;
    const requests = item.requests;
    if (!isWebSearchProviderName(provider)) return { type: 'invalid', index: i, error: 'invalid provider' };
    if (typeof keyId !== 'string' || keyId.length === 0) return { type: 'invalid', index: i, error: 'keyId must be a non-empty string' };
    if (action !== 'search' && action !== 'fetch_page') return { type: 'invalid', index: i, error: 'action must be "search" or "fetch_page"' };
    if (typeof hour !== 'string' || !SEARCH_USAGE_HOUR_PATTERN.test(hour)) return { type: 'invalid', index: i, error: 'hour must match the SEARCH_USAGE_HOUR_PATTERN' };
    if (typeof requests !== 'number' || !Number.isSafeInteger(requests) || requests < 0) return { type: 'invalid', index: i, error: 'requests must be a non-negative safe integer' };

    records.push({ provider, keyId, action, hour, requests });
  }

  return { type: 'ok', records };
};

const parseSearchConfig = (value: unknown): { type: 'ok'; config: SearchConfig } | { type: 'invalid'; error: string } => {
  // Delegate to the shared strict parser so the import layer and the
  // load/save helpers cannot drift on what counts as a valid stored
  // config. The strict parser throws a descriptive Error; we map that
  // back into the route's structured invalid envelope here.
  try {
    return { type: 'ok', config: parseSearchConfigStrict(value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: 'invalid', error: message };
  }
};

const parsePerformanceIncluded = (data: Record<string, unknown>): { type: 'ok'; included: boolean } | { type: 'invalid'; error: string } => {
  if (typeof data.performanceIncluded !== 'boolean') return { type: 'invalid', error: 'performanceIncluded must be a boolean' };
  if (!data.performanceIncluded && hasOwn(data, 'performance')) {
    return { type: 'invalid', error: 'performance must be omitted unless performanceIncluded is true' };
  }
  return { type: 'ok', included: data.performanceIncluded };
};

const parsePerformanceRecords = (value: unknown): { type: 'ok'; records: PerformanceTelemetryRecord[] } | { type: 'invalid'; index: number } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1 };

  const records: PerformanceTelemetryRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== 'object') return { type: 'invalid', index: i };

    const item = record as Record<string, unknown>;
    if (
      typeof item.hour !== 'string' ||
      !SEARCH_USAGE_HOUR_PATTERN.test(item.hour) ||
      !isPerformanceMetricScope(item.metricScope) ||
      typeof item.keyId !== 'string' ||
      item.keyId.length === 0 ||
      typeof item.model !== 'string' ||
      item.model.length === 0 ||
      (item.upstream !== null && typeof item.upstream !== 'string') ||
      (typeof item.upstream === 'string' && isLegacyUpstreamIdentity(item.upstream)) ||
      typeof item.modelKey !== 'string' ||
      item.modelKey.length === 0 ||
      !isPerformanceApiName(item.sourceApi) ||
      !isPerformanceApiName(item.targetApi) ||
      typeof item.stream !== 'boolean' ||
      typeof item.runtimeLocation !== 'string' ||
      item.runtimeLocation.length === 0 ||
      !isNonNegativeSafeInteger(item.requests) ||
      !isNonNegativeSafeInteger(item.errors) ||
      !isNonNegativeSafeInteger(item.totalMsSum) ||
      !Array.isArray(item.buckets)
    ) {
      return { type: 'invalid', index: i };
    }

    const buckets = [];
    for (const bucket of item.buckets) {
      if (!bucket || typeof bucket !== 'object') return { type: 'invalid', index: i };
      const bucketItem = bucket as Record<string, unknown>;
      if (!isNonNegativeSafeInteger(bucketItem.lowerMs) || !isNonNegativeSafeInteger(bucketItem.upperMs) || !isNonNegativeSafeInteger(bucketItem.count) || bucketItem.upperMs <= bucketItem.lowerMs) {
        return { type: 'invalid', index: i };
      }
      buckets.push({ lowerMs: bucketItem.lowerMs, upperMs: bucketItem.upperMs, count: bucketItem.count });
    }

    records.push({
      hour: item.hour,
      metricScope: item.metricScope,
      keyId: item.keyId,
      model: item.model,
      upstream: item.upstream as string | null,
      modelKey: item.modelKey,
      sourceApi: item.sourceApi,
      targetApi: item.targetApi,
      stream: item.stream,
      runtimeLocation: item.runtimeLocation,
      requests: item.requests,
      errors: item.errors,
      totalMsSum: item.totalMsSum,
      buckets,
    });
  }

  return { type: 'ok', records };
};

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPerformanceMetricScope = (value: unknown): value is PerformanceMetricScope => typeof value === 'string' && PERFORMANCE_METRIC_SCOPES.has(value as PerformanceMetricScope);

const isPerformanceApiName = (value: unknown): value is PerformanceApiName => typeof value === 'string' && PERFORMANCE_API_NAMES.has(value as PerformanceApiName);

const proxyRecordToExportEntry = (record: ProxyRecord): SerializedProxy => ({
  id: record.id,
  name: record.name,
  url: record.url,
  sort_order: record.sortOrder,
  dial_timeout_seconds: record.dialTimeoutSeconds,
});

/** GET /api/export — dump all data as JSON. The payload includes proxy URIs verbatim (passwords / UUIDs / PSKs) and every other stored credential; handle the file with the same care as a database backup. */
export const exportData = async (c: CtxWithQuery<typeof exportQuery>) => {
  const repo = getRepo();
  const includePerformance = c.req.valid('query').include_performance === '1';

  const [apiKeys, usage, searchUsage, performance, rawSearchConfig, upstreams, proxies] = await Promise.all([
    repo.apiKeys.list(),
    repo.usage.listAll(),
    repo.searchUsage.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.searchConfig.get(),
    repo.upstreams.list(),
    repo.proxies.list(),
  ]);

  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      apiKeys,
      upstreams: upstreams.map(upstreamRecordToFullJson),
      proxies: proxies.map(proxyRecordToExportEntry),
      usage,
      searchUsage,
      performanceIncluded: includePerformance,
      searchConfig: rawSearchConfig === null ? parseSearchConfigDefault() : parseSearchConfigStrict(rawSearchConfig),
    },
  };
  if (includePerformance) payload.data.performance = performance;

  return c.json(payload);
};

/** POST /api/import — import data with merge or replace mode */
export const importData = async (c: CtxWithJson<typeof importBody>) => {
  const body = c.req.valid('json');
  const { mode, data } = body;

  if (!isRecord(data)) return c.json({ error: 'data is required' }, 400);

  const apiKeysResult = parseApiKeyRecords(data.apiKeys);
  if (apiKeysResult.type === 'invalid') {
    const location = apiKeysResult.index >= 0 ? ` at index ${apiKeysResult.index}` : '';
    return c.json({ error: `invalid apiKeys${location}: ${apiKeysResult.error}` }, 400);
  }
  const apiKeys = apiKeysResult.records;

  const usageResult = parseUsageRecords(data.usage);
  if (usageResult.type === 'invalid') {
    const location = usageResult.index >= 0 ? ` at index ${usageResult.index}` : '';
    return c.json({ error: `invalid usage${location}: ${usageResult.error}` }, 400);
  }
  const usage = usageResult.records;

  const upstreamsResult = parseUpstreamRecords(data.upstreams);
  if (upstreamsResult.type === 'invalid') {
    const location = upstreamsResult.index >= 0 ? ` at index ${upstreamsResult.index}` : '';
    return c.json({ error: `invalid upstreams${location}: ${upstreamsResult.error}` }, 400);
  }
  const upstreams = upstreamsResult.records;

  const proxiesResult = parseProxyRecords(data.proxies);
  if (proxiesResult.type === 'invalid') {
    const location = proxiesResult.index >= 0 ? ` at index ${proxiesResult.index}` : '';
    return c.json({ error: `invalid proxies${location}: ${proxiesResult.error}` }, 400);
  }
  const proxies = proxiesResult.records;

  const proxyIdentityError = validateProxyIdentities(proxies);
  if (proxyIdentityError) return c.json({ error: `invalid proxies: ${proxyIdentityError}` }, 400);

  const fallbackRefError = validateProxyFallbackReferences(upstreams, proxies);
  if (fallbackRefError) return c.json({ error: `invalid upstreams: ${fallbackRefError}` }, 400);

  const searchUsageResult = parseSearchUsageRecords(data.searchUsage);
  if (searchUsageResult.type === 'invalid') {
    const location = searchUsageResult.index >= 0 ? ` at index ${searchUsageResult.index}` : '';
    return c.json({ error: `invalid searchUsage${location}: ${searchUsageResult.error}` }, 400);
  }
  const searchUsage = searchUsageResult.records;

  const searchConfigResult = parseSearchConfig(data.searchConfig);
  if (searchConfigResult.type === 'invalid') {
    return c.json({ error: `invalid searchConfig: ${searchConfigResult.error}` }, 400);
  }
  const searchConfig = searchConfigResult.config;

  const performanceIncludedResult = parsePerformanceIncluded(data);
  if (performanceIncludedResult.type === 'invalid') {
    return c.json({ error: performanceIncludedResult.error }, 400);
  }
  const performanceIncluded = performanceIncludedResult.included;
  const performanceResult = performanceIncluded ? parsePerformanceRecords(data.performance) : { type: 'ok' as const, records: [] };
  if (performanceResult.type === 'invalid') {
    return c.json({ error: performanceResult.index >= 0 ? `invalid performance record at index ${performanceResult.index}` : 'invalid performance: performance must be an array when included' }, 400);
  }
  const performance = performanceResult.records;

  const repo = getRepo();
  const apiKeyIdentityError = validateApiKeyIdentities(apiKeys, mode === 'merge' ? await repo.apiKeys.list() : [], mode);
  if (apiKeyIdentityError) return c.json({ error: `invalid apiKeys: ${apiKeyIdentityError}` }, 400);

  if (mode === 'replace') {
    // Replace mode is intentionally non-atomic across repos: D1 binding does not expose multi-repo
    // transactions, and a coordinated batch would require every repo to surface its writes as
    // prepared statements. A failure between the deleteAll wave and the per-record save loop
    // leaves the deployment partially wiped. Operators should back up before running replace mode.
    const existingUpstreams = await repo.upstreams.list();
    const deletes = [
      repo.apiKeys.deleteAll(),
      repo.usage.deleteAll(),
      repo.searchUsage.deleteAll(),
      repo.upstreams.deleteAll(),
      repo.proxies.deleteAll(),
      repo.responsesSnapshots.deleteAll(),
      repo.responsesItems.deleteAll(),
    ];
    if (performanceIncluded) deletes.push(repo.performance.deleteAll());
    await Promise.all(deletes);
    await Promise.all([...existingUpstreams, ...upstreams].map(upstream => invalidateModelsStore(upstream.id)));
  }

  // Proxies land before upstreams so any concurrent reader (e.g. a request
  // resolving an upstream's fallback list) sees the row referenced by an
  // upstream's proxy_fallback_list as soon as the upstream is visible.
  for (const proxy of proxies) {
    await repo.proxies.save({
      id: proxy.id,
      name: proxy.name,
      url: proxy.url,
      sortOrder: proxy.sort_order,
      dialTimeoutSeconds: proxy.dial_timeout_seconds,
    });
  }
  for (const key of apiKeys) await repo.apiKeys.save(key);
  for (const record of usage) await repo.usage.set(record);
  for (const record of searchUsage) await repo.searchUsage.set(record);
  for (const upstream of upstreams) {
    await repo.upstreams.save(upstream);
    await invalidateModelsStore(upstream.id);
  }
  for (const record of performance) await repo.performance.set(record);
  await repo.searchConfig.save(searchConfig);

  return c.json({
    ok: true,
    imported: {
      apiKeys: apiKeys.length,
      upstreams: upstreams.length,
      proxies: proxies.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      performance: performance.length,
    },
  });
};
