import type { CopilotFetchOptions } from "../../../lib/copilot.ts";
import type { BackgroundScheduler } from "../../../lib/background.ts";
import type { ExecuteResult } from "../shared/errors/result.ts";
import type { ProtocolFrame, StreamFrame } from "../shared/stream/types.ts";
import type { SourceApi } from "../shared/types/source-api.ts";

export interface EmitInput<TPayload extends { model: string }> {
  sourceApi: SourceApi;
  payload: TPayload;
  githubToken: string;
  accountType: string;
  apiKeyId?: string;
  clientStream?: boolean;
  runtimeLocation?: string;
  scheduleBackground?: BackgroundScheduler;
  fetchOptions?: CopilotFetchOptions;
  downstreamAbortSignal?: AbortSignal;
}

export type RawEmitResult<TJson> = ExecuteResult<StreamFrame<TJson>>;

export type EmitResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;
