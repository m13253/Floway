// Copilot-only Messages target workarounds. The Copilot provider attaches this
// set to its provider metadata, so the generic target assembler does not need
// to know which provider kind is running.

import type { MessagesResponse } from "../../../../../shared/protocol/messages.ts";
import type { TargetInterceptor } from "../../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../../emit.ts";
import { withThinkingDisplayPromoted } from "./promote-thinking-display.ts";
import { withCacheControlScopeStripped } from "./strip-cache-control-scope.ts";
import { withEagerInputStreamingStripped } from "./strip-eager-input-streaming.ts";

export const messagesCopilotInterceptors = [
  withThinkingDisplayPromoted,
  withCacheControlScopeStripped,
  withEagerInputStreamingStripped,
] as const satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];
