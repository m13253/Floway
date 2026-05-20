import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../shared/protocol/chat-completions.ts";
import {
  asJsonObject,
  type JsonObject,
  readJsonNumber,
} from "../../../../../shared/json-helpers.ts";
import { jsonFrame, sseFrame } from "../../../shared/stream/types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * Normalize OpenAI-compatible upstream `usage` into the OpenAI standard shape
 * so translation and telemetry can read one contract regardless of vendor:
 *
 * 1. Cache token field names are rewritten into
 *    `prompt_tokens_details.cached_tokens` (the standard). Variants observed:
 *    - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *      (https://api-docs.deepseek.com/guides/kv_cache)
 *    - Kimi / Moonshot: flat `cached_tokens` on usage in examples
 *      (https://platform.kimi.com/docs/api/chat)
 *    The standard shape itself (already-correct upstreams) is left untouched.
 *
 * 2. Final-usage chunk position: the OpenAI spec puts the final `usage` on a
 *    `choices: []` carrier chunk
 *    (https://platform.openai.com/docs/api-reference/chat-streaming).
 *    Some upstreams have been observed to attach `usage` to the same chunk
 *    that carries the final delta and `finish_reason`. We strip `usage` from
 *    such a chunk and re-emit it on a synthesized spec-compliant carrier chunk
 *    immediately after.
 */

const VENDOR_USAGE_FIELDS = [
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cached_tokens",
] as const;

const extractCacheRead = (usage: JsonObject): number | null => {
  const standard = readJsonNumber(
    asJsonObject(usage.prompt_tokens_details)?.cached_tokens,
  );
  if (standard != null) return standard;
  const dsHit = readJsonNumber(usage.prompt_cache_hit_tokens);
  if (dsHit != null) return dsHit;
  const kimi = readJsonNumber(usage.cached_tokens);
  if (kimi != null) return kimi;
  return null;
};

const normalizeUsage = (usage: JsonObject): JsonObject => {
  const cacheRead = extractCacheRead(usage);
  const out: JsonObject = { ...usage };
  for (const field of VENDOR_USAGE_FIELDS) delete out[field];
  if (cacheRead != null) {
    out.prompt_tokens_details = {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: cacheRead,
    };
  }
  return out;
};

const isCarrierChunk = (root: JsonObject): boolean => {
  const choices = root.choices;
  return Array.isArray(choices) && choices.length === 0;
};

const splitOrNormalizeStreamFrame = (data: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [data];
  }
  const root = asJsonObject(parsed);
  if (!root) return [data];
  const usage = asJsonObject(root.usage);
  if (!usage) return [data];

  const normalized = normalizeUsage(usage);
  if (isCarrierChunk(root)) {
    return [JSON.stringify({ ...root, usage: normalized })];
  }

  // Relocate: original chunk loses its `usage`; carrier chunk gets it so
  // downstream readers see usage only on the spec-compliant `choices: []` shape.
  const withoutUsage: JsonObject = { ...root };
  delete withoutUsage.usage;
  const carrier: JsonObject = {
    id: root.id,
    object: root.object,
    created: root.created,
    model: root.model,
    choices: [],
    usage: normalized,
  };
  return [JSON.stringify(withoutUsage), JSON.stringify(carrier)];
};

const normalizeNonStreamResponse = (
  response: ChatCompletionResponse,
): ChatCompletionResponse => {
  const usage = asJsonObject((response as unknown as JsonObject).usage);
  if (!usage) return response;
  return {
    ...response,
    usage: normalizeUsage(usage) as unknown as ChatCompletionResponse["usage"],
  };
};

export const withUsageNormalized: TargetInterceptor<
  { payload: ChatCompletionsPayload },
  ChatCompletionResponse
> = async (_ctx, run) => {
  const result = await run();
  if (result.type !== "events") return result;
  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type === "sse") {
          for (const data of splitOrNormalizeStreamFrame(frame.data)) {
            yield sseFrame(data, frame.event);
          }
          continue;
        }
        yield jsonFrame(normalizeNonStreamResponse(frame.data));
      }
    })(),
  };
};
