import { directFetcher, type CacheRepo, type LlmTargetApi, type ModelProvider, type ModelProviderInstance, type ProviderCandidate, type ProviderModelRecord, type TelemetryModelIdentity, type UpstreamCallOptions, type UpstreamModel } from '@floway-dev/provider';

// No-op options for tests that call provider methods directly without going
// through the gateway's recorder. The fetcher uses the runtime `fetch` so
// tests that spy on `globalThis.fetch` still intercept the upstream hit.
export const noopUpstreamCallOptions: UpstreamCallOptions = {
  fetcher: directFetcher,
  recordUpstreamLatency: <T>(promise: Promise<T>): Promise<T> => promise,
};

export const memoryCacheRepo = (): CacheRepo => {
  const store = new Map<string, string>();
  return {
    get: key => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: key => {
      store.delete(key);
      return Promise.resolve();
    },
    deletePrefix: prefix => {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      return Promise.resolve();
    },
  };
};

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

// Auto-wrap a caller-provided mock impl so its returned value flows through
// the per-call `recordUpstreamLatency` hook. Gateway-side tests stub provider
// methods with `vi.fn(async () => ...)` and would otherwise leave the gateway
// recorder uninvoked, tripping its enforce-throw. Wrapping at the stub-
// provider layer keeps the spy's mock.calls intact (the inner fn still
// records every arg including opts) while satisfying the contract.
const autoWrap = <T>(impl: T | undefined): T | undefined => {
  if (!impl) return undefined;
  const fn = impl as unknown as (...args: unknown[]) => Promise<unknown> | unknown;
  return ((...args: unknown[]) => {
    const opts = args[args.length - 1] as UpstreamCallOptions;
    return opts.recordUpstreamLatency(Promise.resolve(fn(...args)));
  }) as unknown as T;
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: overrides.getProvidedModels ?? (() => Promise.resolve([])),
  getPricingForModelKey: overrides.getPricingForModelKey ?? (() => null),
  callChatCompletions: autoWrap(overrides.callChatCompletions) ?? (() => Promise.reject(new Error('stubProvider.callChatCompletions was called'))),
  callResponses: autoWrap(overrides.callResponses) ?? (() => Promise.reject(new Error('stubProvider.callResponses was called'))),
  callResponsesCompact: autoWrap(overrides.callResponsesCompact) ?? (() => Promise.reject(new Error('stubProvider.callResponsesCompact was called'))),
  callMessages: autoWrap(overrides.callMessages) ?? (() => Promise.reject(new Error('stubProvider.callMessages was called'))),
  callMessagesCountTokens: autoWrap(overrides.callMessagesCountTokens) ?? (() => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called'))),
  callEmbeddings: autoWrap(overrides.callEmbeddings) ?? (() => Promise.reject(new Error('stubProvider.callEmbeddings was called'))),
  callImagesGenerations: autoWrap(overrides.callImagesGenerations) ?? (() => Promise.reject(new Error('stubProvider.callImagesGenerations was called'))),
  callImagesEdits: autoWrap(overrides.callImagesEdits) ?? (() => Promise.reject(new Error('stubProvider.callImagesEdits was called'))),
});

const stubProviderInstance = (overrides: Partial<ModelProviderInstance> = {}): ModelProviderInstance => ({
  upstream: 'test-upstream',
  providerKind: 'custom',
  name: 'Test Upstream',
  disabledPublicModelIds: [],
  provider: stubProvider(),
  supportsResponsesItemReference: false,
  ...overrides,
});

const stubProviderModelRecord = (overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord => {
  const provider = overrides.provider ?? stubProvider();
  return {
    upstream: 'test-upstream',
    upstreamName: 'Test Upstream',
    providerKind: 'custom',
    provider,
    upstreamModel: stubUpstreamModel(),
    enabledFlags: new Set<string>(),
    supportsResponsesItemReference: false,
    ...overrides,
  };
};

export const stubProviderCandidate = (overrides: { targetApi?: LlmTargetApi; binding?: Partial<ProviderModelRecord>; provider?: ModelProviderInstance } = {}): ProviderCandidate => {
  const provider = overrides.provider ?? stubProviderInstance();
  return {
    provider,
    binding: stubProviderModelRecord({ provider: provider.provider, ...(overrides.binding ?? {}) }),
    targetApi: overrides.targetApi ?? 'messages',
    fetcher: directFetcher,
  };
};
