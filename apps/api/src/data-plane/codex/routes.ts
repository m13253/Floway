// Codex 1p-compatibility namespace.
//
// The OpenAI Codex CLI in OAuth ("ChatGPT") mode talks to two base URLs that
// must be configured side-by-side in `~/.codex/config.toml`:
//
//   chatgpt_base_url           — backend endpoints (jwks, plugins, analytics,
//                                wham, codex-namespaced catalog/compact)
//   [model_providers.x].base_url — LLM endpoints (responses)
//
// Pointing both at the same prefix lets a single floway deployment serve every
// surface codex expects. The prefix must contain an Azure marker so codex's
// `is_azure_responses_endpoint()` returns true; that unlocks `store: true` +
// `attach_item_ids` in codex's client (model-provider-info substring scan
// against `openai.azure.`, `cognitiveservices.azure.`, `aoai.azure.`,
// `azure-api.`, `azurefd.`, `windows.net/openai`), which is what restores
// ResponseItem ids on the wire so server-side state (encrypted reasoning
// content, web search results, prompt cache) is correctly bound across turns.
//
// Path-prefix split: the LLM data plane is reached through `model_providers`
// and codex sends to `<provider.base_url>/responses` verbatim — no extra
// prefix. The ChatGPT-backend surface, in contrast, prefixes a `/codex/`
// segment for the catalog / analytics / compaction endpoints
// (`<chatgpt_base_url>/codex/models`, `…/codex/analytics-events/events`,
// `…/codex/responses/compact`) while leaving `wham/*`, `plugins/*`, and
// `ps/plugins/*` directly under the base. The mount table below mirrors
// codex's actual request paths exactly.
//
// Auth: this whole namespace is reached through the same `authMiddleware`
// that protects every other API route. The operator forges
// `~/.codex/auth.json` with `tokens.access_token` set to their floway API
// key string; codex's `CodexAuth::get_token()` returns access_token verbatim
// and sends it as `Authorization: Bearer <key>`; `extractKey()` in
// middleware/auth.ts already accepts that header, so the namespace inherits
// API-key auth with no new code.
//
// `/responses/compact` (remote compaction) is intentionally unrouted. codex
// gates the remote-vs-local choice on `provider.supports_remote_compaction()`
// (provider name or Azure URL substring), not on any catalog field, and a
// non-2xx on the compact endpoint aborts the turn instead of falling back to
// local. Until we implement a real compaction handler, leaving it 404 is no
// worse than the alternatives.

import type { Hono } from 'hono';

import {
  codexAnalyticsEventsEvents,
  codexPluginsFeatured,
  codexPluginsList,
  codexPsPluginsInstalled,
  codexPsPluginsList,
  codexWhamAgentIdentitiesJwks,
  codexWhamApps,
} from './chatgpt-backend.ts';
import { codexModels } from './models.ts';
import { responsesTraits } from '../llm/sources/responses/traits.ts';
import { serveLlm } from '../llm/sources/serve.ts';

const CODEX_BASE_PATH = '/azure-api.codex';

export const mountCodexRoutes = (app: Hono) => {
  const serveResponses = serveLlm(responsesTraits);

  app.post(`${CODEX_BASE_PATH}/responses`, serveResponses);

  app.get(`${CODEX_BASE_PATH}/codex/models`, codexModels);
  app.post(`${CODEX_BASE_PATH}/codex/analytics-events/events`, codexAnalyticsEventsEvents);

  app.get(`${CODEX_BASE_PATH}/wham/agent-identities/jwks`, codexWhamAgentIdentitiesJwks);
  app.post(`${CODEX_BASE_PATH}/wham/apps`, codexWhamApps);

  app.get(`${CODEX_BASE_PATH}/plugins/featured`, codexPluginsFeatured);
  app.get(`${CODEX_BASE_PATH}/plugins/list`, codexPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/list`, codexPsPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/installed`, codexPsPluginsInstalled);
};
