import { assertEquals, assertFalse } from "@std/assert";
import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import { stripUnsupportedToolsFromPayload } from "./strip-unsupported-tools.ts";

Deno.test("stripUnsupportedToolsFromPayload removes image_generation tools", () => {
  const payload = {
    model: "gpt-test",
    input: "draw this",
    tools: [
      { type: "image_generation" },
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object" },
        strict: false,
      },
    ],
    tool_choice: "auto",
  } as unknown as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, "function");
  assertEquals(payload.tool_choice, "auto");
});

Deno.test("stripUnsupportedToolsFromPayload removes forced image_generation tool_choice", () => {
  const payload = {
    model: "gpt-test",
    input: "draw this",
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
  } as unknown as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertFalse("tools" in payload);
  assertFalse("tool_choice" in payload);
});

Deno.test("stripUnsupportedToolsFromPayload removes required tool_choice when no tools remain", () => {
  const payload = {
    model: "gpt-test",
    input: "draw this",
    tools: [{ type: "image_generation" }],
    tool_choice: "required",
  } as unknown as ResponsesPayload;

  stripUnsupportedToolsFromPayload(payload);

  assertFalse("tools" in payload);
  assertFalse("tool_choice" in payload);
});
