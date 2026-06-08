// GET /v1/models and /models — single superset handler.
// OpenAI and Anthropic /models field names do not overlap, so one payload
// satisfies both client shapes.

import type { Context } from 'hono';

import { loadModels } from './load.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

const apiErrorResponse = (message: string, status: number): Response => Response.json({ error: { message, type: 'api_error' } }, { status });

// Upstream HTTP/parse failures are squashed to a generic 502 so we do not
// leak upstream identity. Other errors (e.g. the registry's "no upstream
// configured" hint) carry actionable operator guidance and surface verbatim.
const modelLoadErrorResponse = (error: unknown): Response => {
  if (error instanceof ProviderModelsUnavailableError) {
    return apiErrorResponse('Upstream model listing failed', 502);
  }
  return apiErrorResponse(error instanceof Error ? error.message : String(error), 502);
};

export const models = async (c: Context) => {
  try {
    return Response.json(await loadModels(effectiveUpstreamIdsFromContext(c)));
  } catch (e) {
    return modelLoadErrorResponse(e);
  }
};
