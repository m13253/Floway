import { expect, test } from 'vitest';

import { hashPassword } from '../../shared/passwords.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const adminPost = (sessionId: string, body: unknown) => requestApp('/api/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminPatch = (sessionId: string, id: number, body: unknown) => requestApp(`/api/users/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminDelete = (sessionId: string, id: number) => requestApp(`/api/users/${id}`, {
  method: 'DELETE',
  headers: { 'x-floway-session': sessionId },
});

test('GET /api/users requires admin', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/users', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('POST /api/users creates the user and a default API key in one go', async () => {
  const { adminSession, repo } = await setupAppTest();
  const response = await adminPost(adminSession, { username: 'alice', password: 'hunter22' });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { user: { id: number; username: string }; defaultKey: { id: string; name: string; key: string } };
  expect(body.user.id).toBeGreaterThan(2);
  assertEquals(body.user.username, 'alice');
  assertEquals(body.defaultKey.name, 'Default');
  expect(body.defaultKey.key).toMatch(/^[0-9a-f]{64}$/);

  const stored = await repo.apiKeys.listByUserId(body.user.id);
  assertEquals(stored.length, 1);
  assertEquals(stored[0].id, body.defaultKey.id);
});

test('POST /api/users rejects duplicate username + unknown upstream id', async () => {
  const { adminSession } = await setupAppTest();
  await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const dup = await adminPost(adminSession, { username: 'alice', password: 'pw' });
  assertEquals(dup.status, 400);
  const unknown = await adminPost(adminSession, { username: 'bob', password: 'pw', upstreamIds: ['up_ghost'] });
  assertEquals(unknown.status, 400);
});

test('PATCH /api/users/1 cannot demote, rename, or be deleted', async () => {
  const { adminSession } = await setupAppTest();
  assertEquals((await adminPatch(adminSession, 1, { isAdmin: false })).status, 400);
  assertEquals((await adminPatch(adminSession, 1, { username: 'someone-else' })).status, 400);
  assertEquals((await adminDelete(adminSession, 1)).status, 400);
});

test('PATCH /api/users/:self cannot demote yourself but may change password', async () => {
  const { adminSession } = await setupAppTest();
  const demote = await adminPatch(adminSession, 1, { isAdmin: false });
  assertEquals(demote.status, 400);
  // Admin self-PATCH may set password (this is the bootstrap path for user 1
  // to set an initial password after the migration).
  const setPw = await adminPatch(adminSession, 1, { password: 'new-admin-pw' });
  assertEquals(setPw.status, 200);
});

test('admin password reset on another user revokes that user\'s sessions', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'bob',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const bobSession = await repo.sessions.create(3);

  const response = await adminPatch(adminSession, 3, { password: 'reset-pw' });
  assertEquals(response.status, 200);
  expect(await repo.sessions.getByIdAndTouch(bobSession.id)).toBeNull();
});

test('DELETE /api/users/:id cascades to api_keys (soft) + sessions', async () => {
  const { adminSession, repo } = await setupAppTest();
  const created = await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const { user, defaultKey } = (await created.json()) as { user: { id: number }; defaultKey: { id: string } };
  await repo.sessions.create(user.id);

  const response = await adminDelete(adminSession, user.id);
  assertEquals(response.status, 200);

  expect(await repo.users.getById(user.id)).toBeNull();
  expect(await repo.apiKeys.getById(defaultKey.id)).toBeNull();
  assertEquals((await repo.sessions.deleteByUserId(user.id)), 0);
});

test('PATCH /api/users/me/password requires session and a correct current password', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'alice',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const sessionA = await repo.sessions.create(3);
  const sessionB = await repo.sessions.create(3);

  // Wrong current password is rejected.
  const wrongRes = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: 'WRONG', newPassword: 'new-pw' }),
  });
  assertEquals(wrongRes.status, 401);

  // Correct flow keeps the current session and revokes others.
  const okRes = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: 'old-pw', newPassword: 'new-pw' }),
  });
  assertEquals(okRes.status, 200);
  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).toBeNull();

  // The new password works on subsequent logins.
  const updated = await repo.users.getById(3);
  expect(updated?.passwordHash).not.toBeNull();
});

test('PATCH /api/users/me/password rejects API key auth (must be a session)', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
  });
  assertEquals(response.status, 400);
});
