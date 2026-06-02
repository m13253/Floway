// Codex 1p-compatibility namespace.
//
// The OpenAI Codex CLI in OAuth ("ChatGPT") mode talks to two base URLs that
// must be configured side-by-side in `~/.codex/config.toml`:
//
//   chatgpt_base_url           — backend endpoints (jwks, plugins, analytics, wham)
//   [model_providers.x].base_url — LLM endpoints (responses, models)
//
// Pointing both at the same prefix lets a single floway deployment serve every
// surface codex expects. We require the prefix to contain an Azure marker so
// codex's `is_azure_responses_endpoint()` returns true; that unlocks
// `store: true` + `attach_item_ids` in codex's client (model-provider-info
// substring scan against `openai.azure.`, `cognitiveservices.azure.`,
// `aoai.azure.`, `azure-api.`, `azurefd.`, `windows.net/openai`), which is
// what restores ResponseItem ids on the wire so server-side state (encrypted
// reasoning content, web search results, prompt cache) is correctly bound
// across turns.
//
// `/responses` is forwarded straight to the standard Responses handler — the
// wire shape codex sends in 1p mode is the same OpenAI Responses request.
// `/models` is its own endpoint because codex's internal `ModelsResponse`
// shape (`{"models":[ModelInfo]}`) is distinct from the OpenAI public
// `{"object":"list","data":[...]}` we serve at `/v1/models`.
// `/responses/compact` and the WS transport are handled in separate branches.

import type { Hono } from 'hono';

import { codexAnalyticsEvents, codexPluginsFeatured, codexPluginsList, codexPsPluginsInstalled, codexWhamAgentIdentitiesJwks, codexWhamApps } from './chatgpt-backend.ts';
import { codexModels } from './models.ts';
import { responsesTraits } from '../llm/sources/responses/traits.ts';
import { serveLlm } from '../llm/sources/serve.ts';

export const CODEX_BASE_PATH = '/azure-api.codex';

export const mountCodexRoutes = (app: Hono) => {
  const serveResponses = serveLlm(responsesTraits);

  app.post(`${CODEX_BASE_PATH}/responses`, serveResponses);
  app.get(`${CODEX_BASE_PATH}/models`, codexModels);

  app.get(`${CODEX_BASE_PATH}/wham/agent-identities/jwks`, codexWhamAgentIdentitiesJwks);
  app.post(`${CODEX_BASE_PATH}/wham/apps`, codexWhamApps);
  app.post(`${CODEX_BASE_PATH}/codex/analytics-events/events`, codexAnalyticsEvents);
  app.get(`${CODEX_BASE_PATH}/plugins/featured`, codexPluginsFeatured);
  app.get(`${CODEX_BASE_PATH}/plugins/list`, codexPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/installed`, codexPsPluginsInstalled);
};
