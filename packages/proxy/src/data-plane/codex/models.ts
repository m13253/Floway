// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Catalog source: dynamic by codex client version (see catalog.ts) with a
// bundled snapshot as fallback. Overrides for individual model fields live
// in patches.ts so we track upstream codex behavior automatically and only
// diverge on the fields we explicitly need to (currently: the 1M-context
// tier for gpt-5.5 and gpt-5.4).

import type { Context } from 'hono';

import { resolveCodexCatalog } from './catalog.ts';
import { applyCodexOverrides } from './patches.ts';

export const codexModels = async (c: Context): Promise<Response> => {
  const catalog = await resolveCodexCatalog(c.req.header('user-agent'));
  return Response.json(applyCodexOverrides(catalog));
};
