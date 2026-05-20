import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatReasoningItem,
  Message,
} from "../../../../shared/protocol/chat-completions.ts";
import { jsonFrame, sseFrame } from "../../../shared/stream/types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * DeepSeek's reasoner endpoints expose thinking text through the legacy
 * `reasoning_content` scalar both in responses and in the assistant messages a
 * client must replay during multi-turn tool calls. The gateway's internal
 * protocol is the OpenAI shape, so on upstreams with this fix enabled we rename
 * fields on the way out (`reasoning_text` → `reasoning_content`) and on the way
 * back in (`reasoning_content` → `reasoning_text`).
 *
 * This is required for correctness, not just aesthetics: DeepSeek documents
 * `reasoning_content` as part of the assistant message clients replay during
 * multi-turn tool-call loops, and its integration notes report 400s when that
 * field is omitted.
 *
 * Gating: bound to the `deepseek-reasoning-dialect` flag (declared in
 * ../../../providers/fixes.ts) and enabled per-upstream via
 * `Upstream.enabledFixes`. The assembler in ../index.ts only attaches this
 * interceptor when the upstream opted in, so the body below is unconditional.
 *
 * References:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
 */

type AnyRecord = Record<string, unknown>;

// Synthesize a scalar reasoning text from reasoning_items summaries. Used
// when the client replays the newer OpenAI shape (reasoning_items only,
// no scalar reasoning_text).
const synthesizeFromItems = (
  items: ChatReasoningItem[] | null | undefined,
): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap((item) => item.summary?.map((s) => s.text) ?? []);
  return parts.length > 0 ? parts.join("") : undefined;
};

const rewriteOutboundMessage = (message: Message): Message => {
  // DeepSeek documents only the scalar reasoning_content field. Strip the
  // OpenAI-only fields regardless of whether reasoning_text is present; when
  // reasoning_text is absent, synthesize from reasoning_items summaries so the
  // visible reasoning chain survives the dialect hop.
  const {
    reasoning_text,
    reasoning_opaque: _opaque,
    reasoning_items,
    ...rest
  } = message;

  const text = typeof reasoning_text === "string"
    ? reasoning_text
    : synthesizeFromItems(reasoning_items);

  if (text === undefined) return rest as Message;
  return { ...rest, reasoning_content: text } as Message;
};

const rewriteOutboundPayload = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map(rewriteOutboundMessage),
});

const renameReasoningContentToText = (record: AnyRecord): boolean => {
  if (typeof record.reasoning_content !== "string") return false;
  if (record.reasoning_text === undefined) {
    record.reasoning_text = record.reasoning_content;
  }
  delete record.reasoning_content;
  return true;
};

const rewriteInboundChunkJson = (data: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (!parsed || typeof parsed !== "object") return data;

  const root = parsed as AnyRecord;
  let changed = false;

  const choices = root.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const choiceRecord = choice as AnyRecord;
      const delta = choiceRecord.delta;
      if (delta && typeof delta === "object") {
        if (renameReasoningContentToText(delta as AnyRecord)) changed = true;
      }
      const message = choiceRecord.message;
      if (message && typeof message === "object") {
        if (renameReasoningContentToText(message as AnyRecord)) changed = true;
      }
    }
  }

  return changed ? JSON.stringify(root) : data;
};

const rewriteInboundResponse = (
  response: ChatCompletionResponse,
): ChatCompletionResponse => {
  let changed = false;
  const choices = response.choices.map((choice) => {
    const message = choice.message as unknown as AnyRecord;
    if (renameReasoningContentToText(message)) {
      changed = true;
      return { ...choice, message: message as typeof choice.message };
    }
    return choice;
  });
  return changed ? { ...response, choices } : response;
};

export const withDeepseekReasoningDialect: TargetInterceptor<
  { payload: ChatCompletionsPayload },
  ChatCompletionResponse
> = async (ctx, run) => {
  ctx.payload = rewriteOutboundPayload(ctx.payload);

  const result = await run();
  if (result.type !== "events") return result;

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type === "sse") {
          yield sseFrame(rewriteInboundChunkJson(frame.data), frame.event);
          continue;
        }
        yield jsonFrame(rewriteInboundResponse(frame.data));
      }
    })(),
  };
};
