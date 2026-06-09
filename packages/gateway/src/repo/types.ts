import type { HistogramBucket } from '../shared/performance-histogram.ts';
import type { WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { BillingDimension, ModelPricing } from '@floway-dev/protocols/common';
import type { PerformanceApiName, UpstreamRecord } from '@floway-dev/provider';

export interface ApiKey {
  id: string;
  userId: number;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  // null = inherit global upstream order; array = whitelist + priority order.
  upstreamIds: string[] | null;
  deletedAt: string | null;
}

export interface User {
  id: number;
  username: string;
  // null = the row is not a credential — sign-in is only possible through
  // the ADMIN_KEY backdoor.
  passwordHash: string | null;
  isAdmin: boolean;
  // null = unrestricted at the user level; an array intersects with the
  // per-key whitelist when both are present.
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
  deletedAt: string | null;
}

export interface Session {
  id: string;
  userId: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface UsageRecord {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  requests: number;
  // Disjoint per-dimension token counts for this bucket (see TokenUsage).
  tokens: TokenUsage;
  // Pricing snapshot taken at write time. null means the provider did not
  // resolve pricing for this model (Custom upstreams, unknown Copilot
  // public id, etc.). The repo derives per-dimension unit prices from it via
  // unitPriceForDimension; aggregation treats a null snapshot as cost 0.
  cost: ModelPricing | null;
}

// Disjoint per-dimension token counts. Absent keys mean zero for that
// dimension. No key's count overlaps another's.
export type TokenUsage = Partial<Record<BillingDimension, number>>;

export type SearchUsageAction = 'search' | 'fetch_page';

export interface SearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  action: SearchUsageAction;
  hour: string;
  requests: number;
}

export type PerformanceMetricScope = 'request_total' | 'upstream_success';

export interface PerformanceDimensions {
  hour: string;
  metricScope: PerformanceMetricScope;
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

export interface PerformanceLatencySample extends PerformanceDimensions {
  durationMs: number;
}

export interface PerformanceErrorSample extends PerformanceDimensions {}

export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  errors: number;
  totalMsSum: number;
  buckets: HistogramBucket[];
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  // Includes soft-deleted rows. Telemetry attribution and v4 export need every
  // historical key, including ones the owner has rotated or deleted, so the
  // user_id behind each row stays resolvable.
  listIncludingDeleted(): Promise<ApiKey[]>;
  listByUserId(userId: number): Promise<ApiKey[]>;
  // Self-scope telemetry includes the actor's own soft-deleted keys so a
  // rotated key's name still surfaces in the dashboard's by-key view.
  listByUserIdIncludingDeleted(userId: number): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  idsByUserIdIncludingDeleted(userId: number): Promise<string[]>;
  save(key: ApiKey): Promise<void>;
  softDelete(id: string): Promise<boolean>;
  softDeleteByUserId(userId: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface UsersRepo {
  list(): Promise<User[]>;
  listIncludingDeleted(): Promise<User[]>;
  getById(id: number): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  // Atomic insert that allocates id = MAX(id) + 1 in a single statement so two
  // concurrent admin creates can't compute the same id and silently overwrite
  // each other.
  createNewUser(template: Omit<User, 'id'>): Promise<User>;
  // Throws when the username is already taken by another active row, so
  // duplicate-username races surface instead of silently overwriting state.
  save(user: User): Promise<void>;
  softDelete(id: number): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface SessionsRepo {
  getByIdAndTouch(id: string): Promise<Session | null>;
  create(userId: number): Promise<Session>;
  deleteById(id: string): Promise<boolean>;
  deleteByUserId(userId: number): Promise<number>;
  deleteByUserIdExcept(userId: number, exceptId: string): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface UsageRepo {
  // Additive upsert: on (keyId, model, upstream, modelKey, hour) conflict,
  // token counts are summed. cost is COALESCED — the first write within a
  // bucket establishes the pricing snapshot for that row, later writes that
  // share the bucket keep the original snapshot.
  record(record: UsageRecord): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  // Replacement upsert (counts and cost both overwritten from the record).
  // Used by import/restore flows.
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchUsageRepo {
  record(args: { provider: WebSearchProviderName; keyId: string; action: SearchUsageAction; hour: string; requests: number }): Promise<void>;
  query(opts: { provider?: WebSearchProviderName; keyId?: string; action?: SearchUsageAction; start: string; end: string }): Promise<SearchUsageRecord[]>;
  listAll(): Promise<SearchUsageRecord[]>;
  set(record: SearchUsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface PerformanceRepo {
  recordLatency(sample: PerformanceLatencySample): Promise<void>;
  recordError(sample: PerformanceErrorSample): Promise<void>;
  query(opts: { keyId?: string; metricScope?: PerformanceMetricScope; start: string; end: string }): Promise<PerformanceTelemetryRecord[]>;
  listAll(): Promise<PerformanceTelemetryRecord[]>;
  set(record: PerformanceTelemetryRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown | null>;
  save(config: unknown): Promise<void>;
}

export interface UpstreamRepo {
  list(): Promise<UpstreamRecord[]>;
  getById(id: string): Promise<UpstreamRecord | null>;
  save(upstream: UpstreamRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  // Gateway autonomous state write with optimistic concurrency. Returns
  // updated:true only if the row's state_json equals the serialized form of
  // options.expectedState at write time. On updated:false the caller re-reads
  // and decides whether to retry or drop the update.
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }>;
}

export interface StoredResponsesItem {
  id: string;
  apiKeyId: string | null;
  upstreamId: string | null;
  upstreamItemId: string | null;
  itemType: string;
  origin: 'input' | 'upstream' | 'synthetic';
  payload: StoredResponsesItemPayload | null;
  contentHash: string | null;
  // sha256 of the item's `encrypted_content`, when it carries one (reasoning /
  // compaction). Lets a later turn that echoes the blob without a gateway id
  // recover this row's owning upstream for affinity routing.
  encryptedContentHash: string | null;
  createdAt: number;
  refreshedAt: number;
}

export interface StoredResponsesItemPayload {
  item: unknown;
  // Ancillary state stashed alongside the public `item` body but never sent on
  // the wire: a server-only slot to preserve data a stateless client strips
  // from the echoed item (e.g. the real `web_search_call` results) so a later
  // turn can restore it on replay. Persisted and round-tripped verbatim.
  private?: unknown;
}

export interface ResponsesItemsRepo {
  lookupMany(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItem[]>;
  lookupManyByContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]>;
  lookupManyByEncryptedContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]>;
  insertMany(items: readonly StoredResponsesItem[]): Promise<void>;
  fillPayloads(items: readonly StoredResponsesItem[]): Promise<number>;
  refreshMany(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<number>;
  clearPayloadOlderThan(createdBefore: number): Promise<number>;
  deleteOlderThan(refreshedBefore: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesSnapshot {
  id: string;
  apiKeyId: string | null;
  itemIds: string[];
  createdAt: number;
  refreshedAt: number;
}

export interface ResponsesSnapshotsRepo {
  lookup(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null>;
  insert(snapshot: StoredResponsesSnapshot): Promise<void>;
  refresh(apiKeyId: string | null, id: string, refreshedAt: number): Promise<boolean>;
  deleteOlderThan(refreshedBefore: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;
}
