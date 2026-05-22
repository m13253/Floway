import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertAzureUpstreamRecord, createAzureUpstream, type AzureDeploymentConfig } from '../../../shared/upstream/azure.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { messagesWebSearchShimInterceptors } from '../../llm/sources/messages/interceptors/index.ts';
import { isStreamingEndpoint, publicPathsToModelEndpoints } from '../endpoints.ts';
import { withModelInfoDefaults, type RawModelMetadata } from '../model-info.ts';
import type { ModelEndpoint, ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';

interface AzureProviderData {
  deployment: string;
}

const providerData = (model: UpstreamModel): AzureProviderData => model.providerData as AzureProviderData;

const publicModelId = (deployment: AzureDeploymentConfig): string => {
  const configured = deployment.publicModelId?.trim();
  return configured && configured.length > 0 ? configured : deployment.deployment;
};

const withMessagesCountTokens = (endpoints: readonly ModelEndpoint[]): ModelEndpoint[] =>
  endpoints.includes('messages') && !endpoints.includes('messages_count_tokens') ? [...endpoints, 'messages_count_tokens'] : [...endpoints];

const azureDeploymentEndpoints = (deployment: AzureDeploymentConfig): ModelEndpoint[] => withMessagesCountTokens(publicPathsToModelEndpoints(deployment.supportedEndpoints));

const rawMetadata = (deployment: AzureDeploymentConfig): RawModelMetadata => {
  const metadata: RawModelMetadata = {
    id: publicModelId(deployment),
  };

  if (deployment.display_name !== undefined) metadata.display_name = deployment.display_name;
  if (deployment.capabilities !== undefined) metadata.capabilities = deployment.capabilities;

  return metadata;
};

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);
  const upstream = createAzureUpstream(azure);
  const enabledFixes = new Set(record.enabledFixes);

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ProviderCallResult> => {
    const deployment = providerData(model).deployment;
    const requestBody = isStreamingEndpoint(endpoint) ? { ...body, stream: true, model: deployment } : { ...body, model: deployment };
    return upstream
      .fetch(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          signal,
        },
        extraHeaders ? { extraHeaders } : undefined,
      )
      .then(response => ({
        response,
        modelKey: deployment,
      }));
  };

  const provider: ModelProvider = {
    async getProvidedModels() {
      return azure.config.deployments.map(deployment => {
        const model = withModelInfoDefaults(rawMetadata(deployment));
        return {
          ...model,
          supportedEndpoints: azureDeploymentEndpoints(deployment),
          providerData: {
            deployment: deployment.deployment,
          } satisfies AzureProviderData,
        };
      });
    },
    callChatCompletions: (model, body, signal) => call('chat_completions', model, body, signal),
    callResponses: (model, body, signal) => call('responses', model, body, signal),
    callMessages: (model, body, signal, anthropicBeta) =>
      call('messages', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callMessagesCountTokens: (model, body, signal, anthropicBeta) =>
      call('messages_count_tokens', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callEmbeddings: (model, body, signal) => call('embeddings', model, body, signal),
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    provider,
    enabledFixes,
    ...(enabledFixes.has('messages-web-search-shim')
      ? {
          sourceInterceptors: {
            messages: messagesWebSearchShimInterceptors,
          },
        }
      : {}),
  };
};
