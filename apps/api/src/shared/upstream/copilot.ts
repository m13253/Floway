// Copilot upstream adapter — wraps the existing copilotFetch + token exchange
// behind the generic Upstream interface. Reuses shared/copilot.ts so the token
// cache (in-process + KV) stays shared across all callers.

import { copilotFetch, isCopilotTokenFetchError, type CopilotAccountType } from '../copilot.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';

export interface CopilotUpstream extends Upstream {
  fetch(endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response>;
}

// Copilot mounts its API at the host root and uses an Anthropic-style
// `/v1/messages` for the Messages endpoint while keeping `/chat/completions`,
// `/responses`, `/embeddings`, `/images/*`, and `/models` un-prefixed. These
// paths are not admin-configurable: they reflect Copilot's own contract, not
// a deployment choice. Copilot has no native `/responses/compact` (compaction
// is replicated over `/responses`), so that key is omitted.
const COPILOT_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
  models: '/models',
};

export const COPILOT_ENDPOINTS: ModelEndpoints = { chatCompletions: {}, responses: {}, messages: {}, embeddings: {} };

export const createCopilotUpstream = (id: string, name: string, githubToken: string, accountType: CopilotAccountType): CopilotUpstream => {
  return {
    id,
    name,
    kind: 'copilot',
    endpoints: COPILOT_ENDPOINTS,
    fetch: async (endpoint, init, options) => {
      const path = COPILOT_PATHS[endpoint];
      if (path === undefined) throw new Error(`Copilot upstream does not serve the ${endpoint} endpoint`);
      try {
        return await copilotFetch(path, init, githubToken, accountType, options?.extraHeaders ? { headers: options.extraHeaders } : undefined);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        return new Response(error.body, {
          status: error.status,
          headers: new Headers(error.headers),
        });
      }
    },
  };
};
