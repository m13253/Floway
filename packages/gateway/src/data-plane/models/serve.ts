// OpenAI and Anthropic /models field names do not overlap, so one payload
// satisfies both client shapes.

import type { Context } from 'hono';

import { loadModels } from './load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

export const models = async (c: Context) => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher();
    return Response.json(await loadModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c)));
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError)
      return Response.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, { status: 502 });
    throw e;
  }
};
