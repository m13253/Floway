import { assertEquals } from "@std/assert";
import type { MessagesPayload } from "../../../../shared/protocol/messages.ts";
import {
  stubProvider,
  stubUpstreamModel,
  testTelemetryModelIdentity,
} from "../../../../../test-helpers.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";

const okEvents = () =>
  Promise.resolve(
    eventResult((async function* () {})(), testTelemetryModelIdentity),
  );

const emitInput = (payload: MessagesPayload): EmitToMessagesInput => ({
  sourceApi: "messages",
  model: payload.model,
  upstream: "test-upstream",
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFixes: new Set<string>(),
});

Deno.test("messages forced tool_choice disables thinking and strips output_config", async () => {
  const input = emitInput({
    model: "m",
    messages: [],
    max_tokens: 1,
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "high" },
    tool_choice: { type: "tool", name: "x" },
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.thinking, { type: "disabled" });
  assertEquals(input.payload.output_config, undefined);
});

Deno.test("messages any tool_choice also disables thinking", async () => {
  const input = emitInput({
    model: "m",
    messages: [],
    max_tokens: 1,
    thinking: { type: "enabled", budget_tokens: 1024 },
    tool_choice: { type: "any" },
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.thinking, { type: "disabled" });
});

Deno.test("messages non-forced tool_choice leaves reasoning untouched", async () => {
  for (const type of ["auto", "none"] as const) {
    const input = emitInput({
      model: "m",
      messages: [],
      max_tokens: 1,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type },
    });

    await withReasoningDisabledOnForcedToolChoice(input, okEvents);

    assertEquals(input.payload.thinking, {
      type: "enabled",
      budget_tokens: 1024,
    });
  }
});
