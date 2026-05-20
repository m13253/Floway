import type { MessagesResponse } from "../../../../shared/protocol/messages.ts";
import type { OptionalInterceptor } from "../../optional-interceptor.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";

const baseInterceptors: readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[] = [];

export const messagesOptionalInterceptors = [
  {
    fixId: "disable-reasoning-on-forced-tool-choice",
    run: withReasoningDisabledOnForcedToolChoice,
  },
] as const satisfies readonly OptionalInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];

export const interceptorsForMessages = (
  provider: Pick<EmitToMessagesInput, "enabledFixes" | "targetInterceptors">,
): readonly TargetInterceptor<EmitToMessagesInput, MessagesResponse>[] => [
  ...baseInterceptors,
  ...((provider.targetInterceptors?.messages ??
    []) as readonly TargetInterceptor<
      EmitToMessagesInput,
      MessagesResponse
    >[]),
  ...messagesOptionalInterceptors
    .filter(({ fixId }) => provider.enabledFixes.has(fixId))
    .map(({ run }) => run),
];
