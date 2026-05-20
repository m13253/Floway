import { assertEquals } from "@std/assert";
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../shared/protocol/chat-completions.ts";
import {
  stubUpstream,
  testTelemetryModelIdentity,
} from "../../../../../test-helpers.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";
import type { RawEmitResult } from "../../emit-types.ts";
import { withDeepseekReasoningDialect } from "./normalize-reasoning-dialect.ts";

const baseRequest = (): ChatCompletionsPayload => ({
  model: "deepseek-reasoner",
  messages: [
    { role: "user", content: "first turn" },
    {
      role: "assistant",
      content: null,
      reasoning_text: "let me check the docs",
      reasoning_opaque: "opaque-blob",
      reasoning_items: [{ type: "reasoning", summary: [] }],
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "result",
    },
    { role: "user", content: "next turn" },
  ],
});

const collectFrames = async (
  result: RawEmitResult<ChatCompletionResponse>,
): Promise<StreamFrame<ChatCompletionResponse>[]> => {
  if (result.type !== "events") throw new Error("expected events result");
  const out: StreamFrame<ChatCompletionResponse>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

Deno.test("withDeepseekReasoningDialect renames outbound reasoning_text on a deepseek upstream", async () => {
  const ctx = {
    payload: baseRequest(),
    upstream: stubUpstream({
      enabledFixes: new Set(["deepseek-reasoning-dialect"]),
    }),
  };

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(eventResult(
      (async function* () {
        yield* [];
      })(),
      testTelemetryModelIdentity,
    ));
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, "let me check the docs");
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  // Non-reasoning fields stay intact so the tool-call replay still works.
  assertEquals((assistant.tool_calls as unknown[]).length, 1);
});

Deno.test("withDeepseekReasoningDialect synthesizes reasoning_content from reasoning_items when reasoning_text is absent", async () => {
  const ctx = {
    payload: {
      model: "deepseek-reasoner",
      messages: [
        { role: "user" as const, content: "first turn" },
        {
          role: "assistant" as const,
          content: null,
          reasoning_items: [{
            type: "reasoning" as const,
            id: "rs_1",
            summary: [
              { type: "summary_text" as const, text: "step one. " },
              { type: "summary_text" as const, text: "step two." },
            ],
            encrypted_content: "opaque-blob",
          }],
          tool_calls: [{
            id: "call_1",
            type: "function" as const,
            function: { name: "lookup", arguments: "{}" },
          }],
        },
        { role: "tool" as const, tool_call_id: "call_1", content: "result" },
      ],
    } satisfies ChatCompletionsPayload,
    upstream: stubUpstream({
      enabledFixes: new Set(["deepseek-reasoning-dialect"]),
    }),
  };

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(eventResult(
      (async function* () {
        yield* [];
      })(),
      testTelemetryModelIdentity,
    ));
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, "step one. step two.");
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
});

Deno.test("withDeepseekReasoningDialect strips reasoning_items even when no summaries are available", async () => {
  const ctx = {
    payload: {
      model: "deepseek-reasoner",
      messages: [
        { role: "user" as const, content: "first turn" },
        {
          role: "assistant" as const,
          content: "answer",
          reasoning_items: [{
            type: "reasoning" as const,
            encrypted_content: "opaque-only",
          }],
          reasoning_opaque: "opaque-chain",
        },
      ],
    } satisfies ChatCompletionsPayload,
    upstream: stubUpstream({
      enabledFixes: new Set(["deepseek-reasoning-dialect"]),
    }),
  };

  let observed: ChatCompletionsPayload | null = null;
  await withDeepseekReasoningDialect(ctx, () => {
    observed = ctx.payload;
    return Promise.resolve(eventResult(
      (async function* () {
        yield* [];
      })(),
      testTelemetryModelIdentity,
    ));
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.content, "answer");
});

Deno.test("withDeepseekReasoningDialect renames inbound SSE reasoning_content to reasoning_text", async () => {
  const ctx = {
    payload: baseRequest(),
    upstream: stubUpstream({
      enabledFixes: new Set(["deepseek-reasoning-dialect"]),
    }),
  };
  const upstreamChunk = JSON.stringify({
    id: "chunk_1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-reasoner",
    choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }],
  });

  const result = await withDeepseekReasoningDialect(
    ctx,
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield sseFrame(upstreamChunk);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== "sse") throw new Error("expected SSE frame");
  const decoded = JSON.parse(frame.data) as Record<string, unknown>;
  const choice = (decoded.choices as Array<Record<string, unknown>>)[0];
  const delta = choice.delta as Record<string, unknown>;
  assertEquals(delta.reasoning_text, "thinking...");
  assertEquals(delta.reasoning_content, undefined);
});

Deno.test("withDeepseekReasoningDialect renames inbound non-stream message.reasoning_content", async () => {
  const ctx = {
    payload: baseRequest(),
    upstream: stubUpstream({
      enabledFixes: new Set(["deepseek-reasoning-dialect"]),
    }),
  };
  const upstreamResponse = {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-reasoner",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "ok",
        reasoning_content: "thought trace",
      } as unknown,
      finish_reason: "stop",
    }],
  } as unknown as ChatCompletionResponse;

  const result = await withDeepseekReasoningDialect(
    ctx,
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame(upstreamResponse);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  const frames = await collectFrames(result);
  const frame = frames[0];
  if (frame.type !== "json") throw new Error("expected JSON frame");
  const message = frame.data.choices[0].message as Record<string, unknown>;
  assertEquals(message.reasoning_text, "thought trace");
  assertEquals(message.reasoning_content, undefined);
});
