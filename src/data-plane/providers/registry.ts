import { createAzureProvider } from './azure/provider.ts';
import { createCopilotProvider } from './copilot/provider.ts';
import { createCustomProvider } from './custom/provider.ts';
import { endpointsIncludeLlmGeneration } from './endpoints.ts';
import type { CatalogModel, ModelEndpoint, ModelProviderInstance, ProviderModelRecord, ResolvedModel, UpstreamModel } from './types.ts';
import { getRepo } from '../../repo/index.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '../../repo/types.ts';

interface ProviderModelsResult {
  models: ResolvedModel[];
  sawSuccess: boolean;
  lastError: unknown;
}

type ProviderFactory = (record: UpstreamRecord) => ModelProviderInstance | Promise<ModelProviderInstance>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
};

export const listModelProviders = async (): Promise<ModelProviderInstance[]> => {
  const providers: ModelProviderInstance[] = [];

  const upstreams = await getRepo().upstreams.list();
  for (const upstream of upstreams) {
    if (!upstream.enabled) continue;
    providers.push(await providerFactories[upstream.provider](upstream));
  }

  return providers;
};

const unionEndpoints = (a: readonly ModelEndpoint[], b: readonly ModelEndpoint[]): ModelEndpoint[] => {
  const result = [...a];
  for (const endpoint of b) {
    if (!result.includes(endpoint)) result.push(endpoint);
  }
  return result;
};

const catalogModelFromUpstreamModel = (upstreamModel: UpstreamModel): CatalogModel => {
  const { providerData: _providerData, supportedEndpoints: upstreamSupportedEndpoints, ...modelInfo } = upstreamModel;
  const supportedEndpoints = [...upstreamSupportedEndpoints];

  return {
    ...modelInfo,
    supportedEndpoints,
    supports_generation: endpointsIncludeLlmGeneration(supportedEndpoints),
  };
};

const collectProviderModels = async (providers: readonly ModelProviderInstance[]): Promise<ProviderModelsResult> => {
  const byId = new Map<string, ResolvedModel>();
  let sawSuccess = false;
  let lastError: unknown = null;

  for (const instance of providers) {
    try {
      const providedModels = await instance.provider.getProvidedModels();
      sawSuccess = true;
      for (const upstreamModel of providedModels) {
        if (!upstreamModel.id) continue;
        const record: ProviderModelRecord = {
          upstream: instance.upstream,
          providerKind: instance.providerKind,
          provider: instance.provider,
          upstreamModel,
          enabledFixes: instance.enabledFixes,
          sourceInterceptors: instance.sourceInterceptors,
          targetInterceptors: instance.targetInterceptors,
        };
        const existing = byId.get(upstreamModel.id);
        if (!existing) {
          byId.set(upstreamModel.id, {
            ...catalogModelFromUpstreamModel(upstreamModel),
            providers: [record],
          });
          continue;
        }

        // Known limitation for this refactor: when multiple providers expose
        // the same public model id, the first provider's metadata remains the
        // public /models metadata. Runtime execution still uses the selected
        // provider's own UpstreamModel, so capability-sensitive calls do not
        // depend on this merged view being perfectly representative.
        const supportedEndpoints = unionEndpoints(existing.supportedEndpoints, upstreamModel.supportedEndpoints);
        byId.set(upstreamModel.id, {
          ...existing,
          supportedEndpoints,
          supports_generation: endpointsIncludeLlmGeneration(supportedEndpoints),
          providers: [...existing.providers, record],
        });
      }
    } catch (error) {
      lastError = error;
    }
  }

  return { models: [...byId.values()], sawSuccess, lastError };
};

const modelWithProviderInstances = (model: ResolvedModel, providers: ReadonlySet<ModelProviderInstance>): ResolvedModel => {
  const providerInstances = [...providers];
  const bindings = model.providers.filter(binding => providerInstances.some(instance => instance.upstream === binding.upstream && instance.provider === binding.provider));
  const supportedEndpoints = bindings.reduce<ModelEndpoint[]>((endpoints, binding) => unionEndpoints(endpoints, binding.upstreamModel.supportedEndpoints), []);

  return {
    ...model,
    supportedEndpoints,
    supports_generation: endpointsIncludeLlmGeneration(supportedEndpoints),
    providers: bindings,
  };
};

export const getModels = async (): Promise<ResolvedModel[]> => {
  const providers = await listModelProviders();
  if (providers.length === 0) {
    throw new Error('No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
  }

  const { models, sawSuccess, lastError } = await collectProviderModels(providers);

  if (sawSuccess) return models;
  if (lastError) throw lastError;
  return [];
};

export const getCatalogModels = async (): Promise<CatalogModel[]> => (await getModels()).map(({ providers: _providers, ...model }) => model);

export interface ModelResolution {
  id: string;
  model?: ResolvedModel;
}

const resolveProviderAlias = (providers: readonly ModelProviderInstance[], byId: ReadonlyMap<string, ResolvedModel>, modelId: string): ResolvedModel | undefined => {
  let resolved: ResolvedModel | undefined;
  const providersForAlias = new Set<ModelProviderInstance>();

  for (const instance of providers) {
    const aliasTarget = instance.resolveRequestedModelId?.(modelId);
    if (!aliasTarget || aliasTarget === modelId) continue;

    const model = byId.get(aliasTarget);
    if (!model) continue;
    if (resolved && resolved.id !== model.id) continue;

    const providerHasModel = model.providers.some(binding => binding.upstream === instance.upstream && binding.provider === instance.provider);
    if (!providerHasModel) continue;

    resolved = model;
    providersForAlias.add(instance);
  }

  if (!resolved) return undefined;
  return modelWithProviderInstances(resolved, providersForAlias);
};

export const resolveModelForRequest = async (modelId: string): Promise<ModelResolution> => {
  const providers = await listModelProviders();
  if (providers.length === 0) {
    throw new Error('No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
  }

  const { models, lastError } = await collectProviderModels(providers);
  const byId = new Map(models.map(model => [model.id, model]));

  const exact = byId.get(modelId);
  if (exact) return { id: exact.id, model: exact };

  const alias = resolveProviderAlias(providers, byId, modelId);
  if (alias) return { id: alias.id, model: alias };

  if (lastError) throw lastError;

  return { id: modelId };
};
