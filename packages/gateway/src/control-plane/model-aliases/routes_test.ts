import { test } from 'vitest';

import type { SerializedModelAlias } from './serialize.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const authedGet = (adminSession: string): RequestInit => ({
  method: 'GET',
  headers: { 'x-floway-session': adminSession },
});

const authedJson = (adminSession: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const baseCreate = (overrides: Record<string, unknown> = {}) => ({
  alias: 'opus-xhigh',
  targetModelId: 'claude-opus-4-6',
  upstreamIds: [],
  rules: { reasoning: { effort: 'xhigh' } },
  visibleInModelsList: true,
  onConflict: 'real-only',
  ...overrides,
});

test('GET /api/aliases returns rows sorted by alias', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'zzz-late',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_001,
  });
  await repo.modelAliases.save({
    alias: 'aaa-early',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases', authedGet(adminSession));
  assertEquals(resp.status, 200);
  const list = (await resp.json()) as SerializedModelAlias[];
  assertEquals(list.map(a => a.alias), ['aaa-early', 'zzz-late']);
});

test('POST /api/aliases creates a row and echoes the serialized shape', async () => {
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate({
    displayName: 'Opus Extra-High',
    upstreamIds: ['up_a', 'up_b'],
    rules: { reasoning: { effort: 'xhigh' }, anthropicBeta: ['fine-grained-tool-streaming'] },
  })));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as SerializedModelAlias;
  assertEquals(created.alias, 'opus-xhigh');
  assertEquals(created.target_model_id, 'claude-opus-4-6');
  assertEquals(created.upstream_ids, ['up_a', 'up_b']);
  assertEquals(created.rules, { reasoning: { effort: 'xhigh' }, anthropicBeta: ['fine-grained-tool-streaming'] });
  assertEquals(created.visible_in_models_list, true);
  assertEquals(created.on_conflict, 'real-only');
  assertEquals(created.display_name, 'Opus Extra-High');
  assertEquals(typeof created.created_at, 'number');

  const stored = await repo.modelAliases.getByAlias('opus-xhigh');
  assertEquals(stored?.targetModelId, 'claude-opus-4-6');
  assertEquals(stored?.displayName, 'Opus Extra-High');
});

test('POST /api/aliases defaults onConflict to real-only when omitted', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', {
    alias: 'no-onconflict',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
  }));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as SerializedModelAlias;
  assertEquals(created.on_conflict, 'real-only');
});

test('POST /api/aliases returns 409 on duplicate alias', async () => {
  const { adminSession } = await setupAppTest();

  const first = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate()));
  assertEquals(first.status, 201);

  const dup = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate()));
  assertEquals(dup.status, 409);
  const body = (await dup.json()) as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'conflict');
});

test('POST /api/aliases rejects an empty alias name with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate({ alias: '' })));
  assertEquals(resp.status, 400);
});

test('POST /api/aliases rejects an alias containing whitespace with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate({ alias: 'has space' })));
  assertEquals(resp.status, 400);
});

test('POST /api/aliases rejects an unknown rule key with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate({
    rules: { reasoning: { effort: 'high' }, mysteryKnob: true } as unknown as Record<string, unknown>,
  })));
  assertEquals(resp.status, 400);
});

test('POST /api/aliases rejects an invalid onConflict value with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate({ onConflict: 'mystery-mode' })));
  assertEquals(resp.status, 400);
});

test('POST /api/aliases requires admin auth (non-admin api key returns 403)', async () => {
  const { adminSession, apiKey } = await setupAppTest();

  // Sanity: the admin call succeeds so the failure below pins the auth gate,
  // not a request-shape mistake shared by both calls.
  const adminResp = await requestApp('/api/aliases', authedJson(adminSession, 'POST', baseCreate()));
  assertEquals(adminResp.status, 201);

  const userResp = await requestApp('/api/aliases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(baseCreate({ alias: 'other' })),
  });
  assertEquals(userResp.status, 403);
});

test('PATCH /api/aliases/:alias merges a partial body and preserves untouched fields', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'opus-xhigh',
    targetModelId: 'claude-opus-4-6',
    upstreamIds: ['up_a'],
    rules: { reasoning: { effort: 'xhigh' } },
    visibleInModelsList: true,
    onConflict: 'real-only',
    displayName: 'Existing Label',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/opus-xhigh', authedJson(adminSession, 'PATCH', {
    rules: { reasoning: { effort: 'medium' }, serviceTier: 'priority' },
  }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedModelAlias;
  // Patched fields took effect.
  assertEquals(updated.rules, { reasoning: { effort: 'medium' }, serviceTier: 'priority' });
  // Untouched fields preserved verbatim.
  assertEquals(updated.target_model_id, 'claude-opus-4-6');
  assertEquals(updated.upstream_ids, ['up_a']);
  assertEquals(updated.visible_in_models_list, true);
  assertEquals(updated.display_name, 'Existing Label');
  assertEquals(updated.created_at, 1_700_000_000);
});

test('PATCH /api/aliases/:alias accepts displayName=null to clear the label', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'opus-xhigh',
    targetModelId: 'claude-opus-4-6',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    displayName: 'Existing Label',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/opus-xhigh', authedJson(adminSession, 'PATCH', { displayName: null }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedModelAlias;
  assertEquals(updated.display_name, null);

  const stored = await repo.modelAliases.getByAlias('opus-xhigh');
  assertEquals(stored?.displayName, undefined);
});

test('PATCH /api/aliases/:alias returns 404 when the alias does not exist', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases/nope', authedJson(adminSession, 'PATCH', { visibleInModelsList: false }));
  assertEquals(resp.status, 404);
});

test('PATCH /api/aliases/:alias renames the row when body.alias differs from the path', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'old-name',
    targetModelId: 'gpt-5.4',
    upstreamIds: ['up_a'],
    rules: { reasoning: { effort: 'high' } },
    visibleInModelsList: true,
    onConflict: 'real-only',
    displayName: 'Old Label',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/old-name', authedJson(adminSession, 'PATCH', {
    alias: 'new-name',
    rules: { reasoning: { effort: 'medium' } },
  }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedModelAlias;
  // Response carries the new alias and the patched rules; preserved fields stay intact.
  assertEquals(updated.alias, 'new-name');
  assertEquals(updated.target_model_id, 'gpt-5.4');
  assertEquals(updated.upstream_ids, ['up_a']);
  assertEquals(updated.rules, { reasoning: { effort: 'medium' } });
  assertEquals(updated.display_name, 'Old Label');
  assertEquals(updated.created_at, 1_700_000_000);

  // Repo state: old row gone, new row present.
  assertEquals(await repo.modelAliases.getByAlias('old-name'), null);
  const stored = await repo.modelAliases.getByAlias('new-name');
  assertEquals(stored?.alias, 'new-name');
  assertEquals(stored?.rules, { reasoning: { effort: 'medium' } });
});

test('PATCH /api/aliases/:alias returns 409 when body.alias collides with an existing row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'source',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });
  await repo.modelAliases.save({
    alias: 'taken',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_001,
  });

  const resp = await requestApp('/api/aliases/source', authedJson(adminSession, 'PATCH', { alias: 'taken' }));
  assertEquals(resp.status, 409);
  const body = (await resp.json()) as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'conflict');

  // Both rows untouched.
  assertEquals((await repo.modelAliases.getByAlias('source'))?.alias, 'source');
  assertEquals((await repo.modelAliases.getByAlias('taken'))?.alias, 'taken');
});

test('PATCH /api/aliases/:alias treats body.alias === path as a no-op rename', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'same-name',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/same-name', authedJson(adminSession, 'PATCH', {
    alias: 'same-name',
    targetModelId: 'claude-opus-4-6',
  }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedModelAlias;
  assertEquals(updated.alias, 'same-name');
  assertEquals(updated.target_model_id, 'claude-opus-4-6');
});

test('PATCH /api/aliases/:alias requires admin auth', async () => {
  const { repo, adminSession: _adminSession, apiKey } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'opus-xhigh',
    targetModelId: 'claude-opus-4-6',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });

  const userResp = await requestApp('/api/aliases/opus-xhigh', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ visibleInModelsList: false }),
  });
  assertEquals(userResp.status, 403);
});

test('DELETE /api/aliases/:alias returns 204 on success and removes the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'doomed',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/doomed', authedJson(adminSession, 'DELETE'));
  assertEquals(resp.status, 204);
  assertEquals(await repo.modelAliases.getByAlias('doomed'), null);
});

test('DELETE /api/aliases/:alias returns 404 when the alias does not exist', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/aliases/nope', authedJson(adminSession, 'DELETE'));
  assertEquals(resp.status, 404);
});

test('DELETE /api/aliases/:alias requires admin auth', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.modelAliases.save({
    alias: 'doomed',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
    createdAt: 1_700_000_000,
  });

  const resp = await requestApp('/api/aliases/doomed', {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(resp.status, 403);
});
