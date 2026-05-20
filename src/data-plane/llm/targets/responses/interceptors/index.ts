import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../shared/protocol/responses.ts";
import type { EmitInput } from "../../emit-types.ts";
import type { OptionalInterceptor } from "../../optional-interceptor.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";
import { withCyberPolicyRetried } from "./retry-cyber-policy.ts";

const baseInterceptors: readonly TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
>[] = [];

export const responsesOptionalInterceptors = [
  { fixId: "retry-cyber-policy", run: withCyberPolicyRetried },
  {
    fixId: "disable-reasoning-on-forced-tool-choice",
    run: withReasoningDisabledOnForcedToolChoice,
  },
] as const satisfies readonly OptionalInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
>[];

export const interceptorsForResponses = (
  provider: Pick<
    EmitInput<ResponsesPayload>,
    "enabledFixes" | "targetInterceptors"
  >,
): readonly TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
>[] => [
  ...baseInterceptors,
  ...((provider.targetInterceptors?.responses ??
    []) as readonly TargetInterceptor<
      EmitInput<ResponsesPayload>,
      ResponsesResult
    >[]),
  ...responsesOptionalInterceptors
    .filter(({ fixId }) => provider.enabledFixes.has(fixId))
    .map(({ run }) => run),
];
