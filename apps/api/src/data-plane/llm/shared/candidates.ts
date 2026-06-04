import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmSourceApi, LlmTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

export interface ProviderCandidateEnumeration {
  // Candidates that satisfy both the model resolution and the target-endpoint
  // pick. The serve loop iterates this list.
  readonly candidates: readonly ProviderCandidate[];
  // True when at least one provider resolved the requested model id, even if
  // its endpoint set didn't satisfy `pickTarget`. Distinguishes "model is
  // missing entirely" (false → `model-missing` 404) from "model exists but
  // doesn't expose the endpoint this source needs" (true → `model-unsupported`
  // 400).
  readonly sawModel: boolean;
}

export const enumerateProviderCandidates = async ({
  apiKeyUpstreamIds, model, pickTarget,
  sourceApi: _sourceApi,
}: {
  apiKeyUpstreamIds: readonly string[] | null;
  model: string;
  sourceApi: LlmSourceApi;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
}): Promise<ProviderCandidateEnumeration> => {
  const providers = await listModelProviders(apiKeyUpstreamIds);
  const candidates: ProviderCandidate[] = [];
  let sawModel = false;

  for (const provider of providers) {
    const resolved = await resolveModelForProvider(provider, model);
    if (!resolved) continue;
    sawModel = true;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi });
  }

  return { candidates, sawModel };
};
