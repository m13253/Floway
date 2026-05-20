import { assertEquals } from "@std/assert";
import type { ModelCapabilities } from "../../../providers/capabilities.ts";
import { planMessagesRequest } from "./plan.ts";

const capabilities = (
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities => ({
  supportedEndpoints: [],
  supportsMessages: false,
  supportsResponses: false,
  supportsChatCompletions: false,
  supportsAdaptiveThinking: false,
  ...overrides,
});

Deno.test("planMessagesRequest rejects capability misses instead of chat fallback", () => {
  const plan = planMessagesRequest(capabilities());

  assertEquals(plan, null);
});

Deno.test("planMessagesRequest honors explicit Chat Completions support", () => {
  const plan = planMessagesRequest(
    capabilities({
      supportedEndpoints: ["chat_completions"],
      supportsChatCompletions: true,
    }),
  );

  assertEquals(plan?.target, "chat-completions");
});

Deno.test("planMessagesRequest does not invent legacy fallback without provider endpoints", () => {
  const plan = planMessagesRequest(capabilities());

  assertEquals(plan, null);
});
