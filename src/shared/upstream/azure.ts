import { joinBaseAndPath } from './join.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';
import type { UpstreamRecord } from '../../repo/types.ts';

export interface AzureDeploymentConfig {
  deployment: string;
  publicModelId?: string;
  supportedEndpoints: string[];
  display_name?: string;
  capabilities?: AzureDeploymentCapabilities;
}

export interface AzureDeploymentCapabilities {
  limits?: {
    max_context_window_tokens?: number;
    max_non_streaming_output_tokens?: number;
    max_prompt_tokens?: number;
    max_output_tokens?: number;
  };
  supports?: {
    tool_calls?: boolean;
    parallel_tool_calls?: boolean;
    streaming?: boolean;
    vision?: boolean;
    adaptive_thinking?: boolean;
    reasoning_effort?: string[];
  };
}

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
  deployments: AzureDeploymentConfig[];
}

type AzureUpstreamRecord = UpstreamRecord & {
  provider: 'azure';
  config: AzureUpstreamConfig;
};

const AZURE_OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  models: '/models',
};

const AZURE_ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
};

const OPENAI_DEPLOYMENT_ENDPOINT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/responses', '/v1/responses', '/embeddings', '/v1/embeddings']);
const ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS = new Set(['/v1/messages', '/messages']);
const SUPPORTED_ENDPOINT_PATHS = new Set([...OPENAI_DEPLOYMENT_ENDPOINT_PATHS, ...ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS]);
const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string`);
  return value;
};

const optionalStringField = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Malformed azure upstream config: ${field} must be a string`);
  return value;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isFoundryProjectRootPath = (path: string): boolean => /^\/api\/projects\/[^/]+$/.test(path);

const isAnthropicBasePath = (path: string): boolean => path === '/anthropic' || path === '/anthropic/v1' || path === '/anthropic/v1/messages';

const isAzureEndpointHost = (hostname: string): boolean =>
  AZURE_ENDPOINT_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix) && hostname.length > suffix.length);

const optionalHttpUrlField = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const url = trimTrailingSlash(nonEmptyStringField(value, field).trim());
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`Malformed azure upstream config: ${field} must be an http(s) URL without query or fragment`);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('query or fragment');
    }
  } catch {
    throw new Error(`Malformed azure upstream config: ${field} must be an http(s) URL without query or fragment`);
  }
  return url;
};

const azureEndpointField = (value: unknown, field: string): string => {
  const url = optionalHttpUrlField(value, field);
  if (!url) throw new Error(`Malformed azure upstream config: ${field} is required`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !isAzureEndpointHost(parsed.hostname)) {
    throw new Error(`Malformed azure upstream config: ${field} must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com`);
  }

  const path = trimTrailingSlash(parsed.pathname);
  if (path !== '' && !isFoundryProjectRootPath(path) && !path.endsWith('/openai/v1') && !isAnthropicBasePath(path)) {
    throw new Error(`Malformed azure upstream config: ${field} must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL`);
  }
  return url;
};

const supportedEndpointsField = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string array`);
  }

  const endpoints: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Malformed azure upstream config: ${field} must be a non-empty string array`);
    if (!SUPPORTED_ENDPOINT_PATHS.has(item)) {
      throw new Error(`Malformed azure upstream config: unsupported supportedEndpoints entry ${item}`);
    }
    if (!endpoints.includes(item)) endpoints.push(item);
  }
  return endpoints;
};

const optionalNumberField = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Malformed azure upstream config: ${field} must be a finite number`);
  return value;
};

const optionalBooleanField = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Malformed azure upstream config: ${field} must be a boolean`);
  return value;
};

const optionalStringArrayField = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Malformed azure upstream config: ${field} must be a string array`);
  }
  return [...value];
};

const optionalMetadataRecord = (value: unknown, field: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed azure upstream config: ${field} must be an object`);
  return value;
};

const capabilitiesField = (value: unknown, field: string): AzureDeploymentCapabilities | undefined => {
  const record = optionalMetadataRecord(value, field);
  if (!record) return undefined;

  const limitsRecord = optionalMetadataRecord(record.limits, `${field}.limits`);
  const supportsRecord = optionalMetadataRecord(record.supports, `${field}.supports`);
  return {
    ...(limitsRecord
      ? {
          limits: {
            ...(limitsRecord.max_context_window_tokens !== undefined ? { max_context_window_tokens: optionalNumberField(limitsRecord.max_context_window_tokens, `${field}.limits.max_context_window_tokens`) } : {}),
            ...(limitsRecord.max_non_streaming_output_tokens !== undefined
              ? { max_non_streaming_output_tokens: optionalNumberField(limitsRecord.max_non_streaming_output_tokens, `${field}.limits.max_non_streaming_output_tokens`) }
              : {}),
            ...(limitsRecord.max_prompt_tokens !== undefined ? { max_prompt_tokens: optionalNumberField(limitsRecord.max_prompt_tokens, `${field}.limits.max_prompt_tokens`) } : {}),
            ...(limitsRecord.max_output_tokens !== undefined ? { max_output_tokens: optionalNumberField(limitsRecord.max_output_tokens, `${field}.limits.max_output_tokens`) } : {}),
          },
        }
      : {}),
    ...(supportsRecord
      ? {
          supports: {
            ...(supportsRecord.tool_calls !== undefined ? { tool_calls: optionalBooleanField(supportsRecord.tool_calls, `${field}.supports.tool_calls`) } : {}),
            ...(supportsRecord.parallel_tool_calls !== undefined ? { parallel_tool_calls: optionalBooleanField(supportsRecord.parallel_tool_calls, `${field}.supports.parallel_tool_calls`) } : {}),
            ...(supportsRecord.streaming !== undefined ? { streaming: optionalBooleanField(supportsRecord.streaming, `${field}.supports.streaming`) } : {}),
            ...(supportsRecord.vision !== undefined ? { vision: optionalBooleanField(supportsRecord.vision, `${field}.supports.vision`) } : {}),
            ...(supportsRecord.adaptive_thinking !== undefined ? { adaptive_thinking: optionalBooleanField(supportsRecord.adaptive_thinking, `${field}.supports.adaptive_thinking`) } : {}),
            ...(supportsRecord.reasoning_effort !== undefined ? { reasoning_effort: optionalStringArrayField(supportsRecord.reasoning_effort, `${field}.supports.reasoning_effort`) } : {}),
          },
        }
      : {}),
  };
};

const deploymentField = (value: unknown, index: number): AzureDeploymentConfig => {
  if (!isRecord(value)) throw new Error(`Malformed azure upstream config: deployments[${index}] must be an object`);
  return {
    deployment: nonEmptyStringField(value.deployment, `deployments[${index}].deployment`),
    ...(value.publicModelId !== undefined ? { publicModelId: optionalStringField(value.publicModelId, `deployments[${index}].publicModelId`) } : {}),
    supportedEndpoints: supportedEndpointsField(value.supportedEndpoints, `deployments[${index}].supportedEndpoints`),
    ...(value.display_name !== undefined ? { display_name: optionalStringField(value.display_name, `deployments[${index}].display_name`) } : {}),
    ...(value.capabilities !== undefined ? { capabilities: capabilitiesField(value.capabilities, `deployments[${index}].capabilities`) } : {}),
  };
};

const deploymentsField = (value: unknown): AzureDeploymentConfig[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Malformed azure upstream config: deployments must be a non-empty array');
  }
  return value.map(deploymentField);
};

const deploymentsUseAnyEndpoint = (deployments: readonly AzureDeploymentConfig[], endpoints: ReadonlySet<string>): boolean =>
  deployments.some(deployment => deployment.supportedEndpoints.some(endpoint => endpoints.has(endpoint)));

const validateEndpointCoverage = (config: AzureUpstreamConfig): void => {
  const usesOpenAi = deploymentsUseAnyEndpoint(config.deployments, OPENAI_DEPLOYMENT_ENDPOINT_PATHS);
  const usesAnthropic = deploymentsUseAnyEndpoint(config.deployments, ANTHROPIC_DEPLOYMENT_ENDPOINT_PATHS);

  if (!usesOpenAi && !usesAnthropic) {
    throw new Error('Malformed azure upstream config: deployments must declare at least one OpenAI v1 or Anthropic endpoint');
  }
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  if (record.provider !== 'azure') throw new Error(`Expected azure upstream record, got ${record.provider}`);
  if (!isRecord(record.config)) throw new Error('Malformed azure upstream config: config must be an object');

  const config: AzureUpstreamConfig = {
    endpoint: azureEndpointField(record.config.endpoint, 'endpoint'),
    apiKey: nonEmptyStringField(record.config.apiKey, 'apiKey'),
    deployments: deploymentsField(record.config.deployments),
  };
  validateEndpointCoverage(config);

  return {
    ...record,
    provider: 'azure',
    config,
  };
};

const configuredSupportedEndpoints = (config: AzureUpstreamConfig): string[] => {
  const endpoints: string[] = [];
  for (const deployment of config.deployments) {
    for (const endpoint of deployment.supportedEndpoints) {
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
    }
  }
  return endpoints;
};

const azureOpenAiV1BaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  const path = trimTrailingSlash(url.pathname);
  if (path.endsWith('/openai/v1')) {
    url.pathname = path;
  } else if (path === '/anthropic/v1/messages' || path === '/anthropic/v1' || path === '/anthropic') {
    url.pathname = '/openai/v1';
  } else if (isFoundryProjectRootPath(path)) {
    url.pathname = `${path}/openai/v1`;
  } else {
    url.pathname = '/openai/v1';
  }
  return trimTrailingSlash(url.href);
};

const withAzureFoundryServicesHost = (url: URL): URL => {
  const next = new URL(url.href);
  if (next.hostname.endsWith('.openai.azure.com')) {
    next.hostname = `${next.hostname.slice(0, -'.openai.azure.com'.length)}.services.ai.azure.com`;
  }
  return next;
};

const azureAnthropicBaseUrl = (endpoint: string): string => {
  const url = withAzureFoundryServicesHost(new URL(trimTrailingSlash(endpoint)));
  const path = trimTrailingSlash(url.pathname);
  if (path === '/anthropic/v1/messages') {
    url.pathname = path.slice(0, -'/v1/messages'.length);
  } else if (path === '/anthropic/v1') {
    url.pathname = path.slice(0, -3);
  } else if (path === '/anthropic') {
    url.pathname = path;
  } else {
    url.pathname = '/anthropic';
  }
  return trimTrailingSlash(url.href);
};

const requestUrl = (openAiBaseUrl: string | undefined, anthropicBaseUrl: string | undefined, endpoint: EndpointKey): string => {
  const openAiPath = AZURE_OPENAI_PATHS[endpoint];
  if (openAiPath) {
    if (!openAiBaseUrl) throw new Error('Azure upstream config does not include an OpenAI v1 endpoint');
    return joinBaseAndPath(openAiBaseUrl, openAiPath);
  }

  const anthropicPath = AZURE_ANTHROPIC_PATHS[endpoint];
  if (anthropicPath) {
    if (!anthropicBaseUrl) throw new Error('Azure upstream config does not include an Anthropic endpoint');
    return joinBaseAndPath(anthropicBaseUrl, anthropicPath);
  }

  throw new Error(`Unsupported Azure upstream endpoint ${endpoint}`);
};

const isAnthropicEndpoint = (endpoint: EndpointKey): boolean => endpoint === 'messages' || endpoint === 'messages_count_tokens';

export const createAzureUpstream = (record: UpstreamRecord): Upstream => {
  const { config } = assertAzureUpstreamRecord(record);
  const openAiBaseUrl = azureOpenAiV1BaseUrl(config.endpoint);
  const anthropicBaseUrl = azureAnthropicBaseUrl(config.endpoint);
  return {
    id: record.id,
    name: record.name,
    kind: 'azure',
    supportedEndpoints: configuredSupportedEndpoints(config),
    enabledFixes: new Set(record.enabledFixes),
    fetch: async (endpoint, init: RequestInit, options?: UpstreamFetchOptions) => {
      const headers = new Headers(init.headers);
      if (isAnthropicEndpoint(endpoint)) {
        headers.set('x-api-key', config.apiKey);
        headers.set('anthropic-version', '2023-06-01');
      } else {
        headers.set('api-key', config.apiKey);
      }
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      if (options?.extraHeaders) {
        for (const [key, value] of Object.entries(options.extraHeaders)) {
          headers.set(key, value);
        }
      }
      return await fetch(requestUrl(openAiBaseUrl, anthropicBaseUrl, endpoint), { ...init, headers });
    },
  };
};
