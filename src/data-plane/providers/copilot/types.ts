import type {
  CachedModelInfo,
  CachedModelsResponse,
} from "../upstream-model-cache.ts";

// Raw shape returned by Copilot's upstream /models endpoint. Keep it inside
// the Copilot provider so the rest of the data plane sees only UpstreamModel.
export interface CopilotRawModel extends CachedModelInfo {
  name?: string;
  version?: string;
  object?: string;
  billing?: {
    is_premium?: boolean;
    multiplier?: number;
    restricted_to?: string[];
  };
  policy?: {
    state?: string;
    terms?: string;
  };
}

export type CopilotModelsResponse = CachedModelsResponse<CopilotRawModel>;
