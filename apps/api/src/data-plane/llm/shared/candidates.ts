import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmSourceApi, LlmTargetApi, ModelProviderInstance, ProviderModelRecord } from '@floway-dev/provider';

export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly binding: ProviderModelRecord;
  readonly targetApi: LlmTargetApi;
}

export const enumerateProviderCandidates = async ({
  apiKeyUpstreamIds, model, pickTarget,
  sourceApi: _sourceApi,
}: {
  apiKeyUpstreamIds: readonly string[] | null;
  model: string;
  sourceApi: LlmSourceApi;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
}): Promise<readonly ProviderCandidate[]> => {
  const providers = await listModelProviders(apiKeyUpstreamIds);
  const candidates: ProviderCandidate[] = [];

  for (const provider of providers) {
    const resolved = await resolveModelForProvider(provider, model);
    if (!resolved) continue;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi });
  }

  return candidates;
};
