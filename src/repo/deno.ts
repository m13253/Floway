import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  GitHubAccount,
  GitHubRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceMetricScope,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  Repo,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  UpstreamConfig,
  UpstreamConfigRepo,
  UsageRecord,
  UsageRepo,
} from "./types.ts";
import { assertWebSearchProviderName } from "../shared/web-search-providers.ts";
import { latencyBucketForMs } from "../shared/performance-histogram.ts";

const SEARCH_CONFIG_KEY: Deno.KvKey = ["config", "search_config"];
const GITHUB_ACCOUNT_ORDER_KEY: Deno.KvKey = ["config", "github_account_order"];

class DenoKvApiKeyRepo implements ApiKeyRepo {
  constructor(private kv: Deno.Kv) {}

  async list(): Promise<ApiKey[]> {
    const keys: ApiKey[] = [];
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      keys.push(entry.value);
    }
    return keys;
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    // Fast path: reverse index lookup
    const ref = await this.kv.get<string>(["api_keys_by_key", rawKey]);
    if (ref.value) return this.getById(ref.value);

    // Slow path: scan all keys (handles keys saved before reverse index existed)
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      if (entry.value.key === rawKey) {
        // Lazily backfill the reverse index
        await this.kv.set(["api_keys_by_key", rawKey], entry.value.id);
        return entry.value;
      }
    }
    return null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const entry = await this.kv.get<ApiKey>(["api_keys", id]);
    return entry.value;
  }

  async save(key: ApiKey): Promise<void> {
    const existing = await this.kv.get<ApiKey>(["api_keys", key.id]);
    const ops = this.kv.atomic().set(["api_keys", key.id], key).set([
      "api_keys_by_key",
      key.key,
    ], key.id);
    if (existing.value && existing.value.key !== key.key) {
      ops.delete(["api_keys_by_key", existing.value.key]);
    }
    await ops.commit();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.kv.get<ApiKey>(["api_keys", id]);
    if (!existing.value) return false;
    await this.kv.atomic()
      .delete(["api_keys", id])
      .delete(["api_keys_by_key", existing.value.key])
      .commit();
    return true;
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["api_keys"] })) {
      await this.kv.delete(entry.key);
    }
    for await (const entry of this.kv.list({ prefix: ["api_keys_by_key"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvGitHubRepo implements GitHubRepo {
  constructor(private kv: Deno.Kv) {}

  private async listAccountIds(): Promise<number[]> {
    const ids: number[] = [];
    for await (const entry of this.kv.list({ prefix: ["github_accounts"] })) {
      ids.push(entry.key[1] as number);
    }
    return ids.sort((a, b) => a - b);
  }

  private async readOrder(): Promise<number[]> {
    const orderEntry = await this.kv.get<number[]>(GITHUB_ACCOUNT_ORDER_KEY);
    if (Array.isArray(orderEntry.value)) {
      return orderEntry.value.filter((id): id is number =>
        Number.isInteger(id)
      );
    }

    return [];
  }

  private async writeOrder(userIds: number[]): Promise<void> {
    if (userIds.length === 0) {
      await this.kv.delete(GITHUB_ACCOUNT_ORDER_KEY);
      return;
    }

    await this.kv.set(GITHUB_ACCOUNT_ORDER_KEY, userIds);
  }

  private async normalizeOrder(userIds: number[]): Promise<number[]> {
    const accountIds = await this.listAccountIds();
    const accountIdSet = new Set(accountIds);
    const seen = new Set<number>();
    const ordered = userIds.filter((id) => {
      if (!accountIdSet.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const rest = accountIds.filter((id) => !seen.has(id));
    return [...ordered, ...rest];
  }

  async listAccounts(): Promise<GitHubAccount[]> {
    const accounts: GitHubAccount[] = [];
    for await (
      const entry of this.kv.list<GitHubAccount>({
        prefix: ["github_accounts"],
      })
    ) {
      if (entry.value) accounts.push(withDefaultAccountType(entry.value));
    }
    const rank = new Map(
      (await this.readOrder()).map((id, index) => [id, index]),
    );
    return accounts.sort((a, b) =>
      (rank.get(a.user.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.user.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.user.id - b.user.id
    );
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const entry = await this.kv.get<GitHubAccount>([
      "github_accounts",
      userId,
    ]);
    return entry.value ? withDefaultAccountType(entry.value) : null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    await this.kv.set(["github_accounts", userId], account);
    const order = await this.readOrder();
    if (!order.includes(userId)) {
      await this.writeOrder(await this.normalizeOrder([...order, userId]));
    }
  }

  async deleteAccount(userId: number): Promise<void> {
    await this.kv.delete(["github_accounts", userId]);
    await this.writeOrder(await this.normalizeOrder(await this.readOrder()));
  }

  async setOrder(userIds: number[]): Promise<void> {
    await this.writeOrder(await this.normalizeOrder(userIds));
  }

  async deleteAllAccounts(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["github_accounts"] })) {
      await this.kv.delete(entry.key);
    }
    await this.writeOrder([]);
  }
}

// KV entries created before accountType was added may lack the field
function withDefaultAccountType(account: GitHubAccount): GitHubAccount {
  return account.accountType
    ? account
    : { ...account, accountType: "individual" };
}

class DenoKvTelemetryModelIdentityMigration {
  private promise: Promise<void> | undefined;

  constructor(private kv: Deno.Kv) {}

  ensure(): Promise<void> {
    this.promise ??= this.run().finally(() => {
      this.promise = undefined;
    });
    return this.promise;
  }

  private async run(): Promise<void> {
    await this.migrateUsage();
    await this.migratePerformanceSummaries();
    await this.migratePerformanceBuckets();
    await this.deleteLegacyBackoffs();
  }

  private async migrateUsage(): Promise<void> {
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix: ["usage"] })) {
      if (entry.key.length !== 5) continue;
      const [_prefix, keyId, modelKey, hour, metric] = entry.key;
      if (!isDenoKvStringTuple([keyId, modelKey, hour, metric])) continue;
      const legacyModelKey = modelKey as string;
      await this.moveCounter(
        entry,
        [
          "usage",
          keyId,
          publicModelIdFromLegacyTelemetryModelKey(legacyModelKey),
          "",
          legacyModelKey,
          hour,
          metric,
        ],
      );
    }
  }

  private async migratePerformanceSummaries(): Promise<void> {
    for await (
      const entry of this.kv.list<Deno.KvU64>({
        prefix: ["performance", "summary"],
      })
    ) {
      if (entry.key.length !== 11) continue;
      const [
        _prefix,
        _kind,
        hour,
        metricScope,
        keyId,
        modelKey,
        sourceApi,
        targetApi,
        stream,
        runtimeLocation,
        metric,
      ] = entry.key;
      if (
        !isDenoKvStringTuple([
          hour,
          metricScope,
          keyId,
          modelKey,
          sourceApi,
          targetApi,
          stream,
          runtimeLocation,
          metric,
        ])
      ) continue;
      const legacyModelKey = modelKey as string;
      await this.moveCounter(
        entry,
        [
          "performance",
          "summary",
          hour,
          metricScope,
          keyId,
          publicModelIdFromLegacyTelemetryModelKey(legacyModelKey),
          "",
          legacyModelKey,
          sourceApi,
          targetApi,
          stream,
          runtimeLocation,
          metric,
        ],
      );
    }
  }

  private async migratePerformanceBuckets(): Promise<void> {
    for await (
      const entry of this.kv.list<Deno.KvU64>({
        prefix: ["performance", "bucket"],
      })
    ) {
      if (entry.key.length !== 12) continue;
      const [
        _prefix,
        _kind,
        hour,
        metricScope,
        keyId,
        modelKey,
        sourceApi,
        targetApi,
        stream,
        runtimeLocation,
        lowerMs,
        upperMs,
      ] = entry.key;
      if (
        !isDenoKvStringTuple([
          hour,
          metricScope,
          keyId,
          modelKey,
          sourceApi,
          targetApi,
          stream,
          runtimeLocation,
        ]) ||
        typeof lowerMs !== "number" || typeof upperMs !== "number"
      ) continue;
      const legacyModelKey = modelKey as string;
      await this.moveCounter(
        entry,
        [
          "performance",
          "bucket",
          hour,
          metricScope,
          keyId,
          publicModelIdFromLegacyTelemetryModelKey(legacyModelKey),
          "",
          legacyModelKey,
          sourceApi,
          targetApi,
          stream,
          runtimeLocation,
          lowerMs,
          upperMs,
        ],
      );
    }
  }

  private async deleteLegacyBackoffs(): Promise<void> {
    for await (
      const entry of this.kv.list({ prefix: ["account_model_backoffs"] })
    ) {
      await this.kv.delete(entry.key);
    }
  }

  private async moveCounter(
    entry: Deno.KvEntry<Deno.KvU64>,
    nextKey: Deno.KvKey,
  ): Promise<void> {
    let current = entry;
    while (true) {
      const result = await this.kv.atomic()
        .check(current)
        .sum(nextKey, current.value.value)
        .delete(current.key)
        .commit();
      if (result.ok) return;

      const refreshed = await this.kv.get<Deno.KvU64>(current.key);
      if (refreshed.value === null) return;
      current = refreshed;
    }
  }
}

const isDenoKvStringTuple = (
  values: readonly Deno.KvKeyPart[],
): values is readonly string[] =>
  values.every((value) => typeof value === "string");

const publicModelIdFromLegacyTelemetryModelKey = (modelKey: string): string => {
  if (modelKey === "codex-auto-review") return "gpt-5.4";
  let model = modelKey.startsWith("claude-")
    ? modelKey.replaceAll(".", "-")
    : modelKey;
  if (/-\d{8}$/.test(model)) model = model.slice(0, -9);
  for (const suffix of ["-1m-internal", "-xhigh", "-high", "-1m"]) {
    if (model.endsWith(suffix)) return model.slice(0, -suffix.length);
  }
  return model;
};

class DenoKvUsageRepo implements UsageRepo {
  constructor(
    private kv: Deno.Kv,
    private telemetryModelIdentityMigration:
      DenoKvTelemetryModelIdentityMigration,
  ) {}

  async record(
    keyId: string,
    model: string,
    upstream: string | null,
    modelKey: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    const upstreamKey = upstream ?? "";
    let op = this.kv.atomic()
      .sum(
        ["usage", keyId, model, upstreamKey, modelKey, hour, "r"],
        BigInt(requests),
      )
      .sum(
        ["usage", keyId, model, upstreamKey, modelKey, hour, "i"],
        BigInt(inputTokens),
      )
      .sum(
        ["usage", keyId, model, upstreamKey, modelKey, hour, "o"],
        BigInt(outputTokens),
      );
    if (cacheReadTokens > 0) {
      op = op.sum(
        ["usage", keyId, model, upstreamKey, modelKey, hour, "cr"],
        BigInt(cacheReadTokens),
      );
    }
    if (cacheCreationTokens > 0) {
      op = op.sum(
        ["usage", keyId, model, upstreamKey, modelKey, hour, "cc"],
        BigInt(cacheCreationTokens),
      );
    }
    await op.commit();
  }

  async query(
    opts: { keyId?: string; start: string; end: string },
  ): Promise<UsageRecord[]> {
    await this.telemetryModelIdentityMigration.ensure();
    const prefix: Deno.KvKey = opts.keyId ? ["usage", opts.keyId] : ["usage"];
    const map = new Map<string, UsageRecord>();

    for await (const entry of this.kv.list<Deno.KvU64>({ prefix })) {
      const parsed = usageKeyDimensions(entry.key);
      const { keyId, model, upstream, modelKey, hour, metric } = parsed;
      if (hour < opts.start || hour >= opts.end) continue;

      const mapKey = [keyId, model, upstream ?? "", modelKey, hour].join("\0");
      let rec = map.get(mapKey);
      if (!rec) {
        rec = {
          keyId,
          model,
          upstream,
          modelKey,
          hour,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }

    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async listAll(): Promise<UsageRecord[]> {
    await this.telemetryModelIdentityMigration.ensure();
    const map = new Map<string, UsageRecord>();
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix: ["usage"] })) {
      const { keyId, model, upstream, modelKey, hour, metric } =
        usageKeyDimensions(entry.key);

      const mapKey = [keyId, model, upstream ?? "", modelKey, hour].join("\0");
      let rec = map.get(mapKey);
      if (!rec) {
        rec = {
          keyId,
          model,
          upstream,
          modelKey,
          hour,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }
    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async set(record: UsageRecord): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    const upstreamKey = record.upstream ?? "";
    const modelKey = record.modelKey;
    await this.kv.set(
      [
        "usage",
        record.keyId,
        record.model,
        upstreamKey,
        modelKey,
        record.hour,
        "r",
      ],
      new Deno.KvU64(BigInt(record.requests)),
    );
    await this.kv.set(
      [
        "usage",
        record.keyId,
        record.model,
        upstreamKey,
        modelKey,
        record.hour,
        "i",
      ],
      new Deno.KvU64(BigInt(record.inputTokens)),
    );
    await this.kv.set(
      [
        "usage",
        record.keyId,
        record.model,
        upstreamKey,
        modelKey,
        record.hour,
        "o",
      ],
      new Deno.KvU64(BigInt(record.outputTokens)),
    );
    await this.kv.set(
      [
        "usage",
        record.keyId,
        record.model,
        upstreamKey,
        modelKey,
        record.hour,
        "cr",
      ],
      new Deno.KvU64(BigInt(record.cacheReadTokens ?? 0)),
    );
    await this.kv.set(
      [
        "usage",
        record.keyId,
        record.model,
        upstreamKey,
        modelKey,
        record.hour,
        "cc",
      ],
      new Deno.KvU64(BigInt(record.cacheCreationTokens ?? 0)),
    );
  }

  async deleteAll(): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    for await (const entry of this.kv.list({ prefix: ["usage"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

const usageKeyDimensions = (key: Deno.KvKey): {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  metric: string;
} => {
  const keyId = key[1] as string;
  const upstreamKey = key[3] as string;
  return {
    keyId,
    model: key[2] as string,
    upstream: upstreamKey === "" ? null : upstreamKey,
    modelKey: key[4] as string,
    hour: key[5] as string,
    metric: key[6] as string,
  };
};

class DenoKvSearchUsageRepo implements SearchUsageRepo {
  constructor(private kv: Deno.Kv) {}

  async record(
    provider: SearchUsageRecord["provider"],
    keyId: string,
    hour: string,
    requests: number,
  ): Promise<void> {
    const validProvider = assertWebSearchProviderName(provider);
    await this.kv.atomic()
      .sum(["search_usage", validProvider, keyId, hour, "r"], BigInt(requests))
      .commit();
  }

  async query(
    opts: {
      provider?: SearchUsageRecord["provider"];
      keyId?: string;
      start: string;
      end: string;
    },
  ): Promise<SearchUsageRecord[]> {
    const provider = opts.provider
      ? assertWebSearchProviderName(opts.provider)
      : undefined;
    const prefix: Deno.KvKey = provider
      ? ["search_usage", provider]
      : ["search_usage"];
    const records = await this.collect(prefix);
    return records
      .filter((r) => !opts.keyId || r.keyId === opts.keyId)
      .filter((r) => r.hour >= opts.start && r.hour < opts.end);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    return await this.collect(["search_usage"]);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.kv.set(
      ["search_usage", provider, record.keyId, record.hour, "r"],
      new Deno.KvU64(BigInt(record.requests)),
    );
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["search_usage"] })) {
      await this.kv.delete(entry.key);
    }
  }

  private async collect(prefix: Deno.KvKey): Promise<SearchUsageRecord[]> {
    const records: SearchUsageRecord[] = [];
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix })) {
      records.push({
        provider: assertWebSearchProviderName(entry.key[1]),
        keyId: entry.key[2] as string,
        hour: entry.key[3] as string,
        requests: Number(entry.value),
      });
    }
    return records.sort((a, b) => a.hour.localeCompare(b.hour));
  }
}

class DenoKvPerformanceRepo implements PerformanceRepo {
  constructor(
    private kv: Deno.Kv,
    private telemetryModelIdentityMigration:
      DenoKvTelemetryModelIdentityMigration,
  ) {}

  private dimensionKey(sample: PerformanceDimensions): Deno.KvKeyPart[] {
    return [
      sample.hour,
      sample.metricScope,
      sample.keyId,
      sample.model,
      sample.upstream ?? "",
      sample.modelKey,
      sample.sourceApi,
      sample.targetApi,
      sample.stream ? "1" : "0",
      sample.runtimeLocation,
    ];
  }

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const dimensionKey = this.dimensionKey(sample);
    const bucket = latencyBucketForMs(durationMs);
    await this.kv.atomic()
      .sum(["performance", "summary", ...dimensionKey, "requests"], 1n)
      .sum(
        ["performance", "summary", ...dimensionKey, "total_ms_sum"],
        BigInt(durationMs),
      )
      .sum([
        "performance",
        "bucket",
        ...dimensionKey,
        bucket.lowerMs,
        bucket.upperMs,
      ], 1n)
      .commit();
  }

  async recordError(sample: PerformanceErrorSample): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    await this.kv.atomic()
      .sum(
        ["performance", "summary", ...this.dimensionKey(sample), "errors"],
        1n,
      )
      .commit();
  }

  async query(opts: {
    keyId?: string;
    metricScope?: PerformanceMetricScope;
    start: string;
    end: string;
  }): Promise<PerformanceTelemetryRecord[]> {
    await this.telemetryModelIdentityMigration.ensure();
    return await this.collect({
      summarySelector: {
        start: ["performance", "summary", opts.start],
        end: ["performance", "summary", opts.end],
      },
      bucketSelector: {
        start: ["performance", "bucket", opts.start],
        end: ["performance", "bucket", opts.end],
      },
      filter: (record) => this.matches(record, opts),
    });
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    await this.telemetryModelIdentityMigration.ensure();
    return await this.collect({
      summarySelector: { prefix: ["performance", "summary"] },
      bucketSelector: { prefix: ["performance", "bucket"] },
      filter: () => true,
    });
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    await this.deleteDimension(record);
    const dimensionKey = this.dimensionKey(record);
    let atomic = this.kv.atomic()
      .set(
        ["performance", "summary", ...dimensionKey, "requests"],
        new Deno.KvU64(BigInt(record.requests)),
      )
      .set(
        ["performance", "summary", ...dimensionKey, "errors"],
        new Deno.KvU64(BigInt(record.errors)),
      )
      .set(
        ["performance", "summary", ...dimensionKey, "total_ms_sum"],
        new Deno.KvU64(BigInt(record.totalMsSum)),
      );
    for (const bucket of record.buckets) {
      atomic = atomic.set(
        [
          "performance",
          "bucket",
          ...dimensionKey,
          bucket.lowerMs,
          bucket.upperMs,
        ],
        new Deno.KvU64(BigInt(bucket.count)),
      );
    }
    await atomic.commit();
  }

  async deleteAll(): Promise<void> {
    await this.telemetryModelIdentityMigration.ensure();
    for await (const entry of this.kv.list({ prefix: ["performance"] })) {
      await this.kv.delete(entry.key);
    }
  }

  private async collect(options: {
    summarySelector: Deno.KvListSelector;
    bucketSelector: Deno.KvListSelector;
    filter: (record: PerformanceDimensions) => boolean;
  }): Promise<PerformanceTelemetryRecord[]> {
    const records = new Map<string, PerformanceTelemetryRecord>();
    for await (
      const entry of this.kv.list<Deno.KvU64>(options.summarySelector)
    ) {
      const parsed = this.parseSummaryKey(entry.key);
      if (!options.filter(parsed)) continue;
      const record = this.recordFor(records, parsed);
      const value = Number(entry.value);
      if (parsed.metric === "requests") record.requests = value;
      if (parsed.metric === "errors") record.errors = value;
      if (parsed.metric === "total_ms_sum") record.totalMsSum = value;
    }

    for await (
      const entry of this.kv.list<Deno.KvU64>(options.bucketSelector)
    ) {
      const parsed = this.parseBucketKey(entry.key);
      if (!options.filter(parsed)) continue;
      this.recordFor(records, parsed).buckets.push({
        lowerMs: parsed.lowerMs,
        upperMs: parsed.upperMs,
        count: Number(entry.value),
      });
    }

    return [...records.values()]
      .map((record) => ({
        ...record,
        buckets: record.buckets.toSorted((a, b) =>
          a.upperMs - b.upperMs || a.lowerMs - b.lowerMs
        ),
      }))
      .sort(comparePerformanceTelemetryRecords);
  }

  private parseDimensions(key: Deno.KvKey): PerformanceDimensions {
    const upstreamKey = key[6] as string;
    return {
      hour: key[2] as string,
      metricScope: key[3] as PerformanceMetricScope,
      keyId: key[4] as string,
      model: key[5] as string,
      upstream: upstreamKey === "" ? null : upstreamKey,
      modelKey: key[7] as string,
      sourceApi: key[8] as PerformanceTelemetryRecord["sourceApi"],
      targetApi: key[9] as PerformanceTelemetryRecord["targetApi"],
      stream: key[10] === "1",
      runtimeLocation: key[11] as string,
    };
  }

  private parseSummaryKey(
    key: Deno.KvKey,
  ): PerformanceDimensions & { metric: string } {
    return {
      ...this.parseDimensions(key),
      metric: key[12] as string,
    };
  }

  private parseBucketKey(
    key: Deno.KvKey,
  ): PerformanceDimensions & { lowerMs: number; upperMs: number } {
    return {
      ...this.parseDimensions(key),
      lowerMs: key[12] as number,
      upperMs: key[13] as number,
    };
  }

  private matches(
    record: PerformanceDimensions,
    opts: {
      keyId?: string;
      metricScope?: PerformanceMetricScope;
      start: string;
      end: string;
    },
  ): boolean {
    return record.hour >= opts.start && record.hour < opts.end &&
      (!opts.keyId || record.keyId === opts.keyId) &&
      (!opts.metricScope || record.metricScope === opts.metricScope);
  }

  private recordFor(
    records: Map<string, PerformanceTelemetryRecord>,
    dimensions: PerformanceDimensions,
  ): PerformanceTelemetryRecord {
    const key = [
      dimensions.hour,
      dimensions.metricScope,
      dimensions.keyId,
      dimensions.model,
      dimensions.upstream ?? "",
      dimensions.modelKey,
      dimensions.sourceApi,
      dimensions.targetApi,
      dimensions.stream ? "1" : "0",
      dimensions.runtimeLocation,
    ].join("\0");
    let record = records.get(key);
    if (!record) {
      record = {
        hour: dimensions.hour,
        metricScope: dimensions.metricScope,
        keyId: dimensions.keyId,
        model: dimensions.model,
        upstream: dimensions.upstream,
        modelKey: dimensions.modelKey,
        sourceApi: dimensions.sourceApi,
        targetApi: dimensions.targetApi,
        stream: dimensions.stream,
        runtimeLocation: dimensions.runtimeLocation,
        requests: 0,
        errors: 0,
        totalMsSum: 0,
        buckets: [],
      };
      records.set(key, record);
    }
    return record;
  }

  private async deleteDimension(record: PerformanceDimensions): Promise<void> {
    const dimensionKey = this.dimensionKey(record);
    for (
      const prefix of [
        ["performance", "summary", ...dimensionKey],
        ["performance", "bucket", ...dimensionKey],
      ]
    ) {
      for await (const entry of this.kv.list({ prefix })) {
        await this.kv.delete(entry.key);
      }
    }
  }
}

function comparePerformanceTelemetryRecords(
  a: PerformanceTelemetryRecord,
  b: PerformanceTelemetryRecord,
): number {
  return a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model) ||
    (a.upstream ?? "").localeCompare(b.upstream ?? "") ||
    a.modelKey.localeCompare(b.modelKey) ||
    a.sourceApi.localeCompare(b.sourceApi) ||
    a.targetApi.localeCompare(b.targetApi) ||
    Number(a.stream) - Number(b.stream) ||
    a.runtimeLocation.localeCompare(b.runtimeLocation);
}

class DenoKvCacheRepo implements CacheRepo {
  constructor(private kv: Deno.Kv) {}

  async get(key: string): Promise<string | null> {
    const entry = await this.kv.get<string>(["cache", key]);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    await this.kv.set(
      ["cache", key],
      value,
      ttlMs ? { expireIn: ttlMs } : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(["cache", key]);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["cache"] })) {
      const key = entry.key[1];
      if (typeof key === "string" && key.startsWith(prefix)) {
        await this.kv.delete(entry.key);
      }
    }
  }
}

class DenoKvSearchConfigRepo implements SearchConfigRepo {
  constructor(private kv: Deno.Kv) {}

  async get(): Promise<unknown | null> {
    const entry = await this.kv.get(SEARCH_CONFIG_KEY);
    return entry.value === undefined ? null : entry.value;
  }

  async save(config: unknown): Promise<void> {
    await this.kv.set(SEARCH_CONFIG_KEY, config === undefined ? null : config);
  }
}

class DenoKvUpstreamConfigRepo implements UpstreamConfigRepo {
  constructor(private kv: Deno.Kv) {}

  async list(): Promise<UpstreamConfig[]> {
    const items: UpstreamConfig[] = [];
    for await (
      const entry of this.kv.list<UpstreamConfig>({
        prefix: ["upstream_configs"],
      })
    ) {
      if (entry.value) items.push(entry.value);
    }
    return items.sort((a, b) =>
      a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
    );
  }

  async getById(id: string): Promise<UpstreamConfig | null> {
    const entry = await this.kv.get<UpstreamConfig>(["upstream_configs", id]);
    return entry.value;
  }

  async save(config: UpstreamConfig): Promise<void> {
    await this.kv.set(["upstream_configs", config.id], config);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.kv.get<UpstreamConfig>([
      "upstream_configs",
      id,
    ]);
    if (!existing.value) return false;
    await this.kv.delete(["upstream_configs", id]);
    return true;
  }

  async deleteAll(): Promise<void> {
    for await (
      const entry of this.kv.list({ prefix: ["upstream_configs"] })
    ) {
      await this.kv.delete(entry.key);
    }
  }
}

export class DenoKvRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreamConfigs: UpstreamConfigRepo;

  constructor(kv: Deno.Kv) {
    const telemetryModelIdentityMigration =
      new DenoKvTelemetryModelIdentityMigration(
        kv,
      );
    this.apiKeys = new DenoKvApiKeyRepo(kv);
    this.github = new DenoKvGitHubRepo(kv);
    this.usage = new DenoKvUsageRepo(kv, telemetryModelIdentityMigration);
    this.searchUsage = new DenoKvSearchUsageRepo(kv);
    this.performance = new DenoKvPerformanceRepo(
      kv,
      telemetryModelIdentityMigration,
    );
    this.cache = new DenoKvCacheRepo(kv);
    this.searchConfig = new DenoKvSearchConfigRepo(kv);
    this.upstreamConfigs = new DenoKvUpstreamConfigRepo(kv);
  }
}
