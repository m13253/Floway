import { getRepo } from "../../../repo/index.ts";
import type {
  TelemetryModelIdentity,
  TokenUsage,
} from "../../../repo/types.ts";

export type RecordUsage = (
  modelIdentity: TelemetryModelIdentity,
  usage: TokenUsage,
) => Promise<void>;

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export const hasTokenUsage = (usage: TokenUsage): boolean =>
  usage.inputTokens > 0 || usage.outputTokens > 0 ||
  usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0;

export const recordTokenUsage = async (
  keyId: string,
  modelIdentity: TelemetryModelIdentity,
  usage: TokenUsage,
): Promise<void> => {
  await Promise.all([
    getRepo().usage.record(
      keyId,
      modelIdentity.model,
      modelIdentity.upstream,
      modelIdentity.modelKey,
      currentHour(),
      1,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
    ),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};

export const recordUsageForApiKey = (
  keyId: string | undefined,
): RecordUsage => {
  // Dashboard playground requests authenticate with ADMIN_KEY and intentionally
  // have no API key id. They still pass an explicit recorder so billable source
  // responders cannot accidentally make usage recording optional.
  if (!keyId) return () => Promise.resolve();
  return (modelIdentity, usage) =>
    recordTokenUsage(keyId, modelIdentity, usage);
};

export const recordUsageIfPresent = async (
  modelIdentity: TelemetryModelIdentity,
  usage: TokenUsage | null,
  recordUsage: RecordUsage,
): Promise<void> => {
  if (!usage || !hasTokenUsage(usage)) return;
  await recordUsage(modelIdentity, usage);
};
