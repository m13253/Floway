import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withBetaHeaderFixed } from "./fix-beta-header.ts";
import { withInvalidThinkingBlocksFiltered } from "./filter-invalid-thinking-blocks.ts";
import { withThinkingDisplayPromoted } from "./promote-thinking-display.ts";
import { withDoneSentinelStripped } from "./strip-done-sentinel.ts";
import { withEagerInputStreamingStripped } from "./strip-eager-input-streaming.ts";

export const messagesTargetInterceptors = [
  withInvalidThinkingBlocksFiltered,
  withThinkingDisplayPromoted,
  withBetaHeaderFixed,
  withEagerInputStreamingStripped,
  withDoneSentinelStripped,
] satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];
