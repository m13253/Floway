import { assertEquals } from "@std/assert";
import { testTelemetryModelIdentity } from "../../../../../test-helpers.ts";
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../shared/protocol/chat-completions.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";
import type { RawEmitResult } from "../../emit-types.ts";
import { withUsageNormalized } from "./normalize-usage.ts";

const baseCtx = () => ({
  payload: { model: "test-model", messages: [] } as ChatCompletionsPayload,
});

const collectFrames = async (
  result: RawEmitResult<ChatCompletionResponse>,
): Promise<StreamFrame<ChatCompletionResponse>[]> => {
  if (result.type !== "events") throw new Error("expected events result");
  const out: StreamFrame<ChatCompletionResponse>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

Deno.test("withUsageNormalized rewrites DeepSeek prompt_cache_hit_tokens on non-stream responses", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "deepseek-test",
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 70,
              prompt_cache_miss_tokens: 30,
            },
          } as unknown as ChatCompletionResponse);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const usage = (frames[0] as { type: "json"; data: unknown }).data as {
    usage: Record<string, unknown>;
  };
  assertEquals(usage.usage.prompt_tokens, 100);
  assertEquals(usage.usage.prompt_tokens_details, { cached_tokens: 70 });
  assertEquals("prompt_cache_hit_tokens" in usage.usage, false);
  assertEquals("prompt_cache_miss_tokens" in usage.usage, false);
});

Deno.test("withUsageNormalized rewrites Kimi flat cached_tokens on non-stream responses", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "kimi-test",
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cached_tokens: 50,
            },
          } as unknown as ChatCompletionResponse);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  const usage = (frames[0] as { type: "json"; data: unknown }).data as {
    usage: Record<string, unknown>;
  };
  assertEquals(usage.usage.prompt_tokens_details, { cached_tokens: 50 });
  assertEquals("cached_tokens" in usage.usage, false);
});

Deno.test("withUsageNormalized leaves standard prompt_tokens_details untouched", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "gpt-test",
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 60, audio_tokens: 0 },
            },
          } as unknown as ChatCompletionResponse);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  const usage = (frames[0] as { type: "json"; data: unknown }).data as {
    usage: Record<string, unknown>;
  };
  assertEquals(usage.usage.prompt_tokens_details, {
    cached_tokens: 60,
    audio_tokens: 0,
  });
});

Deno.test("withUsageNormalized passes responses without usage through unchanged", async () => {
  const original = {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "gpt-test",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
  } as unknown as ChatCompletionResponse;

  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame(original);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals((frames[0] as { type: "json"; data: unknown }).data, original);
});

Deno.test("withUsageNormalized relocates DeepSeek usage from a non-empty choices chunk to a synthesized carrier", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield sseFrame(JSON.stringify({
            id: "chatcmpl_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 70,
              prompt_cache_miss_tokens: 30,
            },
          }));
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 2);

  const first = JSON.parse((frames[0] as { type: "sse"; data: string }).data);
  assertEquals(first.choices, [
    { index: 0, delta: {}, finish_reason: "stop" },
  ]);
  assertEquals("usage" in first, false);

  const carrier = JSON.parse((frames[1] as { type: "sse"; data: string }).data);
  assertEquals(carrier.id, "chatcmpl_1");
  assertEquals(carrier.model, "deepseek-test");
  assertEquals(carrier.choices, []);
  assertEquals(carrier.usage.prompt_tokens, 100);
  assertEquals(carrier.usage.prompt_tokens_details, { cached_tokens: 70 });
  assertEquals("prompt_cache_hit_tokens" in carrier.usage, false);
});

Deno.test("withUsageNormalized rewrites usage in-place on a spec-compliant carrier chunk", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield sseFrame(JSON.stringify({
            id: "chatcmpl_2",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-test",
            choices: [],
            usage: {
              prompt_tokens: 80,
              completion_tokens: 10,
              total_tokens: 90,
              cached_tokens: 25,
            },
          }));
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const carrier = JSON.parse((frames[0] as { type: "sse"; data: string }).data);
  assertEquals(carrier.choices, []);
  assertEquals(carrier.usage.prompt_tokens_details, { cached_tokens: 25 });
  assertEquals("cached_tokens" in carrier.usage, false);
});

Deno.test("withUsageNormalized leaves stream chunks without usage untouched", async () => {
  const chunk = JSON.stringify({
    id: "chatcmpl_3",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  });

  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield sseFrame(chunk);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  assertEquals((frames[0] as { type: "sse"; data: string }).data, chunk);
});

Deno.test("withUsageNormalized passes [DONE] sentinel through verbatim", async () => {
  const result = await withUsageNormalized(
    baseCtx(),
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield sseFrame("[DONE]");
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  assertEquals((frames[0] as { type: "sse"; data: string }).data, "[DONE]");
});
