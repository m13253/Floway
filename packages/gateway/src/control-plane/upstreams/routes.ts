import type { Context } from 'hono';
import type { z } from 'zod';

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamRecordToJson, type SerializedUpstreamRecord } from './serialize.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProviderInstance } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_PROXY_ID, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { shortId } from '../../shared/short-id.ts';
import { detectAccountType, fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../auth/github-device-flow.ts';
import type { claudeCodeImportBody, claudeCodePkceStartBody, claudeCodeRefreshNowBody, claudeCodeReimportBody, codexImportBody, codexPkceStartBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createUpstreamBody, fetchModelsBody, updateUpstreamBody } from '../schemas.ts';
import { copilotConfigField, type CopilotUpstreamConfig, isRecord } from '../shared/field-validators.ts';
import { directFetcher, ProviderModelsUnavailableError, getFlagCatalog, type Fetcher, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import {
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamConfig,
  type ClaudeCodeUpstreamState,
  ClaudeCodeOAuthSessionTerminatedError,
  assertClaudeCodeUpstreamRecord,
  buildClaudeCodeAuthorizeUrl,
  extractClaudeCodeCallbackParams,
  generateClaudeCodePkce,
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  readClaudeCodeUpstreamState,
  refreshClaudeCodeAccessToken,
} from '@floway-dev/provider-claude-code';
import {
  type CodexQuotaSnapshot,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_REDIRECT_URI,
  CodexOAuthSessionTerminatedError,
  assertCodexUpstreamRecord,
  assertCodexUpstreamState,
  extractCodexCallbackParams,
  generateCodexPkce,
  getCodexQuota,
  importCodexFromAuthJson,
  importCodexFromCallback,
  refreshCodexAccessToken,
} from '@floway-dev/provider-codex';
import { clearCopilotTokenCache, isCopilotAccountType } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';

// Serialize for the HTTP response, attaching the live codex_quota snapshot
// when the row is a Codex upstream and the SWR models-cache freshness for
// every row. Keeps serialize.ts free of provider I/O and a global repo handle,
// while ensuring every response shape carries the panels the dashboard
// expects.
const serializeForResponse = async (record: UpstreamRecord): Promise<SerializedUpstreamRecord> => {
  let codexQuotaPromise: Promise<CodexQuotaSnapshot | null> | null = null;
  if (record.provider === 'codex') {
    assertCodexUpstreamRecord(record);
    codexQuotaPromise = getCodexQuota(record.id, record.config.accounts[0].chatgptAccountId);
  }
  const cacheRowPromise = getRepo().modelsCache.get(record.id);
  const cacheRow = await cacheRowPromise;
  const serialized = upstreamRecordToJson(record);
  serialized.modelsCache = {
    fetchedAt: cacheRow?.fetchedAt ?? null,
    lastError: cacheRow?.lastError ?? null,
  };
  if (codexQuotaPromise) serialized.codex_quota = await codexQuotaPromise;
  return serialized;
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Pulls the wire-side identifier from a provider's opaque `providerData`
// blob when the provider distinguishes between the public catalog id and
// the upstream id (e.g. claude-code exposes `claude-sonnet-4-5` publicly
// while sending `claude-sonnet-4-5-20250929` on the wire). Falls through
// to undefined when the blob is absent or lacks the field, in which case
// the caller's fallback (`model.id`) keeps the legacy behaviour.
const providerDataUpstreamModelId = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = (data as { upstreamModelId?: unknown }).upstreamModelId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
};

// Run the per-provider invariant asserts on a freshly-built or freshly-merged
// record before it hits the repo. Request-time zod schemas only validate JSON
// shape; these helpers enforce the URL / endpoint-mix / path-override rules
// that the provider packages own.
const normalizeConfig = (record: UpstreamRecord): ValidationResult<unknown> => {
  try {
    if (record.provider === 'custom') return { ok: true, value: assertCustomUpstreamRecord(record).config };
    if (record.provider === 'azure') return { ok: true, value: assertAzureUpstreamRecord(record).config };
    if (record.provider === 'codex') {
      assertCodexUpstreamRecord(record);
      return { ok: true, value: record.config };
    }
    if (record.provider === 'claude-code') {
      assertClaudeCodeUpstreamRecord(record);
      return { ok: true, value: record.config };
    }
    return {
      ok: true,
      value: copilotConfigField(
        record.config,
        (field, expected) => new Error(`Malformed copilot upstream config: ${field} must be ${expected}`),
      ),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const mergeConfigPatch = (provider: UpstreamProviderKind, existing: unknown, patch: unknown): ValidationResult<unknown> => {
  if (!isRecord(patch)) return { ok: false, error: 'config must be an object' };
  const next: Record<string, unknown> = {
    ...(isRecord(existing) ? structuredClone(existing) : {}),
    ...structuredClone(patch),
  };

  if (provider === 'custom' && patch.pathOverrides === null) delete next.pathOverrides;
  return { ok: true, value: next };
};

const newId = (): string => shortId('up');

const nextSortOrder = (upstreams: readonly UpstreamRecord[]): number => upstreams.reduce((acc, upstream) => Math.max(acc, upstream.sortOrder), -1) + 1;

// Synchronously populate the SWR models cache for a freshly-saved upstream
// so the dashboard's next navigation lands on a populated row. Upstream
// fetch failures are persisted to the row's `lastError` by runFetch and
// surfaced by the dashboard, so we discard the throw here. Provider
// instance and fetcher construction errors are not swallowed; those signal
// genuine misconfiguration that the operator must see.
const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<void> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const instance = await createProviderInstance(record);
  const fetcher = (await createPerRequestFetcher())(record.id);
  try {
    await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: true });
  } catch { /* discarded — see above */ }
};

// 'direct' is always valid; any other entry must reference an existing
// proxy row. List order matters at dial time (see createFetcher),
// and persistence layers dedupe via normalizeProxyFallbackList before
// storing.
const validateProxyFallbackList = async (list: readonly string[]): Promise<{ ok: true } | { ok: false; error: string }> => {
  const ids = list.filter(id => id !== DIRECT_PROXY_ID);
  if (ids.length === 0) return { ok: true };
  const proxies = await getRepo().proxies.list();
  const known = new Set(proxies.map(p => p.id));
  for (const id of ids) {
    if (!known.has(id)) return { ok: false, error: `unknown proxy id in fallback list: ${id}` };
  }
  return { ok: true };
};

export const listUpstreams = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(await Promise.all(items.map(serializeForResponse)));
};

// Picker dataset for the per-key upstream whitelist editor. Non-admin users
// need to know which upstreams exist to scope their keys, but they must not
// see operator-tuned config (model lists, flag overrides, copilot user info,
// etc.). This minimal projection is the only upstream surface mounted outside
// the admin zone.
export const listUpstreamOptions = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(upstream => ({
      id: upstream.id,
      name: upstream.name,
      provider: upstream.provider,
      enabled: upstream.enabled,
    })));
};

export const listOptionalFlags = (c: Context) => c.json(getFlagCatalog());

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

  // Codex credentials carry an OAuth refresh_token + id_token-derived identity
  // that this endpoint cannot synthesize. Route the operator to the dedicated
  // PKCE / import flow instead of letting a `provider: 'codex'` body through
  // with no credential material.
  if (body.provider === 'codex') {
    return c.json({ error: 'Use POST /api/upstreams/codex-import for codex provider' }, 400);
  }
  // Same rationale for claude-code: the row carries an OAuth refresh token and
  // an identity derived from /api/oauth/profile, neither of which is
  // synthesizable from a plain POST.
  if (body.provider === 'claude-code') {
    return c.json({ error: 'Use POST /api/upstreams/claude-code-import for claude-code provider' }, 400);
  }

  const proxyFallbackList = normalizeProxyFallbackList(body.proxy_fallback_list ?? []);
  const fallbackCheck = await validateProxyFallbackList(proxyFallbackList);
  if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const upstream: UpstreamRecord = {
    id: newId(),
    provider: body.provider,
    name: body.name,
    enabled: body.enabled ?? true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    proxyFallbackList,
    config: body.config,
    state: null,
  };

  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  const record = { ...upstream, config: config.value };
  await getRepo().upstreams.save(record);
  await warmModelsCache(record, c);
  return c.json(await serializeForResponse(record), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody>) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = c.req.valid('json');
  if (body.provider !== undefined && body.provider !== existing.provider) {
    return c.json({ error: 'provider cannot be changed' }, 400);
  }

  // Codex `config` (id_token-derived identity) and credential state are
  // owned by the dedicated re-import / refresh endpoints. Generic PATCH still
  // adjusts the surrounding row metadata (name, enabled, sort_order, flag
  // overrides, disabled model ids) but never the credential payload.
  if (existing.provider === 'codex' && body.config !== undefined) {
    return c.json({ error: 'Use POST /api/upstreams/:id/codex-reimport to update codex credentials' }, 400);
  }
  // Same gate for claude-code: identity comes from /api/oauth/profile at
  // import time and the credential state belongs to refresh-now / re-import,
  // not a generic field patch.
  if (existing.provider === 'claude-code' && body.config !== undefined) {
    return c.json({ error: 'Use POST /api/upstreams/:id/claude-code-reimport to update claude-code credentials' }, 400);
  }

  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.sort_order !== undefined) next = { ...next, sortOrder: body.sort_order };
  if (body.flag_overrides !== undefined) next = { ...next, flagOverrides: body.flag_overrides };
  if (body.disabled_public_model_ids !== undefined) next = { ...next, disabledPublicModelIds: body.disabled_public_model_ids };
  if (body.proxy_fallback_list !== undefined) {
    const normalized = normalizeProxyFallbackList(body.proxy_fallback_list);
    const fallbackCheck = await validateProxyFallbackList(normalized);
    if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);
    next = { ...next, proxyFallbackList: normalized };
  }
  if (body.config !== undefined) {
    const config = mergeConfigPatch(existing.provider, existing.config, body.config);
    if (!config.ok) return c.json({ error: config.error }, 400);
    next = { ...next, config: config.value };
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };

  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

export const deleteUpstream = async (c: Context) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const repo = getRepo();
  const deleted = await repo.upstreams.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  // No FK from proxy_upstream_backoffs to upstreams; clean up explicitly.
  await repo.proxyBackoffs.resetForUpstream(id);
  return c.json({ ok: true });
};

// Browse the live `/models` list of a DRAFT (unsaved) custom upstream so
// the editor can pick models before saving. Saved upstreams use
// GET /api/upstreams/:id/models?refresh=true instead, which routes through
// the SWR cache.
export const fetchModels = async (c: CtxWithJson<typeof fetchModelsBody>) => {
  const { id, config } = c.req.valid('json');
  if (id !== undefined) {
    return c.json({
      error: { message: 'use GET /api/upstreams/:id/models?refresh=true for saved upstreams', type: 'invalid_request_error' },
    }, 400);
  }

  const now = new Date().toISOString();
  const record: UpstreamRecord = {
    id: newId(),
    provider: 'custom',
    name: 'Draft custom upstream',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config,
    state: null,
  };

  let assertedConfig;
  try {
    assertedConfig = assertCustomUpstreamRecord(record).config;
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }

  try {
    const result = await fetchCustomModels(assertedConfig, directFetcher);
    return c.json(result);
  } catch (e) {
    // Mirror the control-plane /models convention: squash genuine upstream
    // HTTP/parse failures to a generic 502 without leaking provider identity.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    throw e;
  }
};

// List the resolved model catalog of a SAVED upstream (any provider). A
// read-only view for the dashboard — Copilot's catalog in particular is fixed
// by the upstream and the operator cannot edit it. Routes through the SWR
// models cache; `?refresh=true` forces a fresh upstream fetch.
export const listUpstreamModels = async (c: Context) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const record = await getRepo().upstreams.getById(id);
  if (!record) return c.json({ error: 'upstream not found' }, 404);

  const refresh = c.req.query('refresh') === 'true';
  const scheduler = backgroundSchedulerFromContext(c);
  const fetcher = (await createPerRequestFetcher())(record.id);

  try {
    const instance = await createProviderInstance(record);
    const models = await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: refresh });
    const data = models.map(model => ({
      upstreamModelId: providerDataUpstreamModelId(model.providerData) ?? model.id,
      publicModelId: model.id,
      kind: model.kind,
      endpoints: model.endpoints,
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
      ...(model.cost ? { cost: model.cost } : {}),
    }));
    return c.json({ data });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    throw e;
  }
};

export const copilotAuthStart = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

const copilotConfigUserId = (config: unknown): number | null => {
  if (!isRecord(config) || !isRecord(config.user)) return null;
  return typeof config.user.id === 'number' && Number.isSafeInteger(config.user.id) ? config.user.id : null;
};

// The body's optional `proxy_fallback_list` is the operator's in-progress
// edit-form override. Threaded into every GitHub-side fetch (poll, user
// lookup, account-type) so the device flow lands through the proxy chain
// they're configuring rather than direct egress.
export const copilotAuthPoll = async (c: CtxWithJson<typeof copilotAuthPollBody>) => {
  try {
    const { device_code: deviceCode, proxy_fallback_list: proxyFallbackList } = c.req.valid('json');
    const fetcher = await resolveControlPlaneFetcher({ override: proxyFallbackList });

    const data = await pollGitHubDeviceFlow(deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down', interval: data.interval });
    if (data.error) return c.json({ status: 'error', error: data.error_description ?? data.error }, 400);

    if (!data.access_token) return c.json({ status: 'error', error: 'Unknown response' }, 500);

    const user = await fetchGitHubUser(data.access_token, fetcher);
    const accountType = await detectAccountType(data.access_token, fetcher);
    if (!isCopilotAccountType(accountType)) {
      return c.json({ status: 'error', error: 'Unsupported Copilot account type' }, 502);
    }

    const repo = getRepo().upstreams;
    const upstreams = await repo.list();
    const existing = upstreams.find(upstream => upstream.provider === 'copilot' && copilotConfigUserId(upstream.config) === user.id);
    const now = new Date().toISOString();
    const config: CopilotUpstreamConfig = {
      githubToken: data.access_token,
      accountType,
      user,
    };

    const record: UpstreamRecord = existing
      ? {
          ...existing,
          config,
          updatedAt: now,
        }
      : {
          id: newId(),
          provider: 'copilot',
          name: user.login ? `GitHub Copilot (${user.login})` : 'GitHub Copilot',
          enabled: true,
          sortOrder: nextSortOrder(upstreams),
          createdAt: now,
          updatedAt: now,
          flagOverrides: {},
          disabledPublicModelIds: [],
          // Persist the override on initial create so the next data-plane
          // call honors the same chain. Existing rows keep their stored
          // fallback list — overrides during poll on an already-existing
          // row are still routed correctly above, but we don't clobber the
          // operator's prior persisted choice.
          proxyFallbackList: proxyFallbackList !== undefined ? normalizeProxyFallbackList(proxyFallbackList) : [],
          config,
          state: null,
        };

    await repo.save(record);
    await clearCopilotTokenCache(record.id);
    await warmModelsCache(record, c);
    return c.json({ status: 'complete', user, upstream: await serializeForResponse(record) });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

// 5 minutes mirrors auth.openai.com's authorization-code lifetime. A stale
// pending state cannot be used for token exchange and is swept by the
// scheduled maintenance job.
const CODEX_PKCE_TTL_MS = 5 * 60 * 1000;

export const codexPkceStart = async (c: CtxWithJson<typeof codexPkceStartBody>) => {
  const { verifier, challenge } = await generateCodexPkce();
  const state = crypto.randomUUID().replace(/-/g, '');
  await getRepo().codexPkcePending.put(state, verifier, Date.now() + CODEX_PKCE_TTL_MS);

  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // OpenAI-side flags codex-cli sets. `id_token_add_organizations` enriches
  // the id_token with the operator's chatgpt_account_id; without it the
  // identity-parsing step in importCodex* throws. `codex_cli_simplified_flow`
  // skips the consent screen for already-authorized clients. `originator`
  // matches the data-plane originator so auth telemetry stays consistent.
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');

  return c.json({
    state,
    authorize_url: url.toString(),
    expires_in_seconds: Math.floor(CODEX_PKCE_TTL_MS / 1000),
  });
};

type CodexCredentialBody = z.infer<typeof codexImportBody> | z.infer<typeof codexReimportBody>;

const ingestCodexCredential = async (
  body: CodexCredentialBody,
  fetcher: Fetcher,
): Promise<{ ok: true; config: CodexUpstreamConfig; state: CodexUpstreamState } | { ok: false; error: string }> => {
  try {
    if (body.auth_json !== undefined) {
      // auth_json ingest parses the JWT locally; no network call uses the
      // fetcher, so it is intentionally not threaded here.
      const out = await importCodexFromAuthJson(body.auth_json);
      return { ok: true, ...out };
    }
    const cb = body.callback;
    if (!cb) return { ok: false, error: 'callback is required when auth_json is absent' };
    let code = cb.code;
    let state = cb.state;
    if (cb.callback_url !== undefined) {
      const parsed = extractCodexCallbackParams(cb.callback_url);
      code = parsed.code;
      state = parsed.state;
    }
    if (!code || !state) {
      return { ok: false, error: 'callback.code and callback.state are required (or supply callback.callback_url)' };
    }
    // Atomic single-use DELETE+RETURNING — a replayed callback for the same
    // state cannot succeed twice, and rows past their TTL are filtered out.
    const pending = await getRepo().codexPkcePending.consume(state);
    if (!pending) {
      return { ok: false, error: 'PKCE state not found or expired; restart the flow' };
    }
    const out = await importCodexFromCallback({ code, codeVerifier: pending.verifier, fetcher });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

export const codexImport = async (c: CtxWithJson<typeof codexImportBody>) => {
  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestCodexCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  // `parseCodexIdTokenClaims` already rejects tokens with a missing email,
  // so the email field is non-empty by the time we get here.
  const defaultName = `ChatGPT Codex (${ingestion.config.accounts[0].email})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    provider: 'codex',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    // Persist the in-flight override so subsequent data-plane calls route
    // through the same chain without an extra edit step.
    proxyFallbackList: body.proxy_fallback_list !== undefined ? normalizeProxyFallbackList(body.proxy_fallback_list) : [],
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  await warmModelsCache(upstream, c);
  return c.json(await serializeForResponse(upstream), 201);
};

export const codexReimport = async (c: CtxWithJson<typeof codexReimportBody>) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }

  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestCodexCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    // Re-import accepts an in-flight proxy override; when present, overwrite
    // the persisted list so subsequent data-plane calls match the chain the
    // operator just used for re-import. Absent override leaves the
    // persisted list untouched.
    proxyFallbackList: body.proxy_fallback_list !== undefined
      ? normalizeProxyFallbackList(body.proxy_fallback_list)
      : existing.proxyFallbackList,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

// The body carries an optional `proxy_fallback_list` override so a refresh
// fired from an unsaved edit-form uses the proxy chain the operator is
// currently editing, not the persisted one. Absent override → fall back to
// the persisted row's list. See proxy-resolution.ts for the layered policy.
export const codexRefreshNow = async (c: CtxWithJson<typeof codexRefreshNowBody>) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }
  // A throw from assertCodexUpstreamState means the row's state column was
  // hand-edited or written by a buggier branch — the framework-level 500
  // handler stack-traces internally without surfacing the parse error to the
  // dashboard.
  assertCodexUpstreamState(existing.state);
  const state = existing.state;
  // The state schema enforces exactly one account; refresh-now mutates that
  // single entry.
  const account = state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-import to recover` }, 400);
  }

  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const tokens = await refreshCodexAccessToken(account.refresh_token, fetcher);
    const now = new Date();
    const nextAccount = {
      ...account,
      refresh_token: tokens.refresh_token,
      // Keep `state_updated_at` untouched on a successful refresh — the row's
      // credential-health status hasn't changed (still 'active'), and bumping
      // the timestamp on every refresh would muddy the dashboard's "credential
      // health changed" signal. Matches `claudeCodeRefreshNow` and both
      // providers' data-plane refresh paths in `access-token-cache.ts`.
      accessToken: {
        token: tokens.access_token,
        expiresAt: now.getTime() + tokens.expires_in * 1000,
        refreshedAt: now.toISOString(),
      },
    };
    const nextState: CodexUpstreamState = { accounts: [nextAccount] };
    // CAS keyed on the just-read state. A losing race here means a concurrent
    // data-plane refresh already rotated the row; their write is at least as
    // fresh as ours, so we surface 409 rather than retry.
    const result = await getRepo().upstreams.saveState(id, nextState, { expectedState: state });
    if (!result.updated) {
      return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
    }
    const fresh = await getRepo().upstreams.getById(id);
    return c.json(fresh ? await serializeForResponse(fresh) : { ok: true });
  } catch (err) {
    // OAuth session terminated (refresh_token replayed, revoked, or
    // app_session_terminated): mirror the data-plane behavior — flip the row
    // to `refresh_failed` so the dashboard surfaces the red badge and the
    // operator sees a Re-import affordance instead of a stale Refresh button.
    if (err instanceof CodexOAuthSessionTerminatedError) {
      const failedAccount = {
        ...account,
        state: 'refresh_failed' as const,
        state_message: err.upstreamMessage,
        state_updated_at: new Date().toISOString(),
        // Refresh failure invalidates whatever access token still sat in state;
        // even if the data-plane somehow bypassed the active-state gate, the
        // cached token wouldn't outlive the refresh failure for long.
        accessToken: null,
      };
      const failedState: CodexUpstreamState = { accounts: [failedAccount] };
      // Best-effort: a losing CAS means a concurrent rotation already wrote
      // newer state, which by definition supersedes ours.
      await getRepo().upstreams.saveState(id, failedState, { expectedState: state });
      // 400, not 502: the upstream IS answering — it's telling us the stored
      // refresh token is dead. That's a client-side credential problem, not
      // an upstream outage. 401 is wrong too: the dashboard's auth client
      // logs the operator out on any 401 (apps/web/src/api/client.ts), and
      // a "your codex credential is dead" condition must not be confused
      // with "your dashboard auth is invalid".
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-import the credential to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }
};

// 5 minutes mirrors claude.ai's authorization-code lifetime. Sweep job in
// scheduled.ts purges rows past their TTL; the import handler also rejects
// expired rows defensively via the `expires_at > ?` filter in `consume`.
const CLAUDE_CODE_PKCE_TTL_MS = 5 * 60 * 1000;

export const claudeCodePkceStart = async (c: CtxWithJson<typeof claudeCodePkceStartBody>) => {
  const { verifier, challenge } = await generateClaudeCodePkce();
  const state = crypto.randomUUID().replace(/-/g, '');
  await getRepo().claudeCodePkcePending.put(state, verifier, Date.now() + CLAUDE_CODE_PKCE_TTL_MS);

  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge });

  return c.json({
    state,
    authorize_url,
    expires_in_seconds: Math.floor(CLAUDE_CODE_PKCE_TTL_MS / 1000),
  });
};

type ClaudeCodeCredentialBody = z.infer<typeof claudeCodeImportBody> | z.infer<typeof claudeCodeReimportBody>;

const ingestClaudeCodeCredential = async (
  body: ClaudeCodeCredentialBody,
  fetcher: Fetcher,
): Promise<{ ok: true; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState } | { ok: false; error: string }> => {
  try {
    if (body.credentials_json !== undefined) {
      const out = await importClaudeCodeFromCredentialsJson(body.credentials_json, fetcher);
      return { ok: true, ...out };
    }
    const cb = body.callback;
    if (!cb) return { ok: false, error: 'callback is required when credentials_json is absent' };
    let code = cb.code;
    let state = cb.state;
    if (cb.callback_url !== undefined) {
      const parsed = extractClaudeCodeCallbackParams(cb.callback_url);
      code = parsed.code;
      state = parsed.state;
    }
    if (!code || !state) {
      return { ok: false, error: 'callback.code and callback.state are required (or supply callback.callback_url)' };
    }
    // Atomic single-use DELETE+RETURNING — a replayed callback for the same
    // state cannot succeed twice, and rows past their TTL are filtered out.
    const pending = await getRepo().claudeCodePkcePending.consume(state);
    if (!pending) {
      return { ok: false, error: 'PKCE state not found or expired; restart the flow' };
    }
    const out = await importClaudeCodeFromCallback({ code, pkceVerifier: pending.verifier, fetcher });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

export const claudeCodeImport = async (c: CtxWithJson<typeof claudeCodeImportBody>) => {
  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const defaultName = `Claude Code (${ingestion.config.accounts[0].email})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    provider: 'claude-code',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    // Persist the in-flight override so subsequent data-plane calls route
    // through the same chain without an extra edit step.
    proxyFallbackList: body.proxy_fallback_list !== undefined ? normalizeProxyFallbackList(body.proxy_fallback_list) : [],
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  await warmModelsCache(upstream, c);
  return c.json(await serializeForResponse(upstream), 201);
};

export const claudeCodeReimport = async (c: CtxWithJson<typeof claudeCodeReimportBody>) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'claude-code') {
    return c.json({ error: 'Claude Code upstream not found' }, 404);
  }

  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    // Re-import accepts an in-flight proxy override; when present, overwrite
    // the persisted list so subsequent data-plane calls match the chain the
    // operator just used for re-import. Absent override leaves the
    // persisted list untouched.
    proxyFallbackList: body.proxy_fallback_list !== undefined
      ? normalizeProxyFallbackList(body.proxy_fallback_list)
      : existing.proxyFallbackList,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

// The body carries an optional `proxy_fallback_list` override so a refresh
// fired from an unsaved edit-form uses the proxy chain the operator is
// currently editing, not the persisted one. Absent override → fall back to
// the persisted row's list. See proxy-resolution.ts for the layered policy.
export const claudeCodeRefreshNow = async (c: CtxWithJson<typeof claudeCodeRefreshNowBody>) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'claude-code') {
    return c.json({ error: 'Claude Code upstream not found' }, 404);
  }

  // A throw from readClaudeCodeUpstreamState means the row's state column was
  // hand-edited or written by a buggier branch — the framework-level 500
  // handler stack-traces internally without surfacing the parse error to the
  // dashboard.
  const state = readClaudeCodeUpstreamState(existing.state);
  // The state schema enforces exactly one account; refresh-now mutates that
  // single entry.
  const account = state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Claude Code upstream is ${account.state}; re-import to recover` }, 400);
  }

  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const tokens = await refreshClaudeCodeAccessToken(account.refreshToken, fetcher);
    const now = new Date();
    const nextAccount: ClaudeCodeAccountCredential = {
      ...account,
      refreshToken: tokens.refresh_token,
      // Keep `state` untouched on a successful refresh — 'active' is already
      // the value we want and bumping stateUpdatedAt on every refresh would
      // muddy the dashboard's "credential health changed" signal. Match the
      // access-token cache's behavior in the data-plane hot path.
      accessToken: {
        token: tokens.access_token,
        expiresAt: now.getTime() + tokens.expires_in * 1000,
        refreshedAt: now.toISOString(),
      },
    };
    const nextState: ClaudeCodeUpstreamState = { accounts: [nextAccount] };
    // CAS keyed on the just-read state. A losing race here means a concurrent
    // data-plane refresh already rotated the row; their write is at least as
    // fresh as ours, so we surface 409 rather than retry.
    const result = await getRepo().upstreams.saveState(id, nextState, { expectedState: state });
    if (!result.updated) {
      return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
    }
    const fresh = await getRepo().upstreams.getById(id);
    return c.json(fresh ? await serializeForResponse(fresh) : { ok: true });
  } catch (err) {
    // OAuth session terminated (refresh_token replayed, revoked, or
    // app_session_terminated): mirror the data-plane behavior — flip the row
    // to `refresh_failed` so the dashboard surfaces the red badge and the
    // operator sees a Re-import affordance instead of a stale Refresh button.
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      const failedAccount: ClaudeCodeAccountCredential = {
        ...account,
        state: 'refresh_failed',
        stateMessage: err.upstreamMessage,
        stateUpdatedAt: new Date().toISOString(),
        // Refresh failure invalidates whatever access token still sat in state;
        // even if the data-plane somehow bypassed the active-state gate, the
        // cached token wouldn't outlive the refresh failure for long.
        accessToken: null,
      };
      const failedState: ClaudeCodeUpstreamState = { accounts: [failedAccount] };
      // Best-effort: a losing CAS means a concurrent rotation already wrote
      // newer state, which by definition supersedes ours.
      await getRepo().upstreams.saveState(id, failedState, { expectedState: state });
      // 400, not 502: the upstream IS answering — it's telling us the stored
      // refresh token is dead. That's a client-side credential problem, not
      // an upstream outage. 401 is wrong too: the dashboard's auth client
      // logs the operator out on any 401 (apps/web/src/api/client.ts), and
      // a "your claude-code credential is dead" condition must not be confused
      // with "your dashboard auth is invalid".
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}. Re-import the credential to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }
};
