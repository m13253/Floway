// User management routes — admin CRUD on /api/users plus the self-service
// password change. The seed admin (id 1) and the actor are protected from
// foot-gun mutations (cannot demote, cannot delete).

import type { Context } from 'hono';

import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { hashPassword, verifyPassword } from '../../shared/passwords.ts';
import type { changeOwnPasswordBody, createUserBody, updateUserBody } from '../schemas.ts';

const userToWire = (u: User) => ({
  id: u.id,
  username: u.username,
  isAdmin: u.isAdmin,
  upstreamIds: u.upstreamIds,
  canViewGlobalTelemetry: u.canViewGlobalTelemetry,
  createdAt: u.createdAt,
  deletedAt: u.deletedAt,
});

const generateRawApiKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

const validateUpstreamIds = async (ids: readonly string[] | null): Promise<string | null> => {
  if (ids === null) return null;
  const upstreams = await getRepo().upstreams.list();
  const known = new Set(upstreams.map(u => u.id));
  const unknown = ids.filter(id => !known.has(id));
  return unknown.length ? `unknown upstream id(s): ${unknown.join(', ')}` : null;
};

const parseUserId = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

export const listUsers = async (c: Context) => {
  const users = await getRepo().users.list();
  return c.json(users.map(userToWire));
};

export const createUser = async (c: CtxWithJson<typeof createUserBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();

  if (await repo.users.findByUsernameActive(body.username)) {
    return c.json({ error: 'username taken' }, 400);
  }
  const upstreamErr = await validateUpstreamIds(body.upstreamIds ?? null);
  if (upstreamErr) return c.json({ error: upstreamErr }, 400);

  // Allocate the next id from the existing rows (including soft-deleted ones,
  // so a recreated username never collides with an old id). The seed admin
  // occupies id 1.
  const all = await repo.users.listIncludingDeleted();
  const newId = all.reduce((max, u) => Math.max(max, u.id), 0) + 1;

  const user: User = {
    id: newId,
    username: body.username,
    passwordHash: await hashPassword(body.password),
    isAdmin: body.isAdmin ?? false,
    upstreamIds: body.upstreamIds ?? null,
    canViewGlobalTelemetry: body.canViewGlobalTelemetry ?? false,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };
  await repo.users.save(user);

  // Every user starts with a Default API key so they can use the playground
  // and CLI immediately after their first login. The cleartext key is not
  // exposed in the create response — admins do not see other users' keys; the
  // new user finds it themselves on the dashboard's Keys page.
  const defaultKey: ApiKey = {
    id: crypto.randomUUID(),
    userId: newId,
    name: 'Default',
    key: generateRawApiKey(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
    deletedAt: null,
  };
  await repo.apiKeys.save(defaultKey);

  return c.json({ user: userToWire(user) }, 201);
};

export const updateUser = async (c: CtxWithJson<typeof updateUserBody>) => {
  const id = parseUserId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid user id' }, 400);
  const body = c.req.valid('json');
  const actorId = c.get('userId') as number;
  const repo = getRepo();

  const existing = await repo.users.getById(id);
  if (!existing) return c.json({ error: 'User not found' }, 404);

  if (id === 1 && body.isAdmin === false) return c.json({ error: 'user 1 cannot be demoted' }, 400);
  if (id === actorId && body.isAdmin === false) {
    return c.json({ error: 'cannot demote yourself' }, 400);
  }
  if (body.username !== undefined && body.username !== existing.username) {
    const dup = await repo.users.findByUsernameActive(body.username);
    if (dup && dup.id !== id) return c.json({ error: 'username taken' }, 400);
  }
  if (body.upstreamIds !== undefined) {
    const err = await validateUpstreamIds(body.upstreamIds);
    if (err) return c.json({ error: err }, 400);
  }

  const next: User = {
    ...existing,
    username: body.username ?? existing.username,
    passwordHash: body.password === undefined ? existing.passwordHash : await hashPassword(body.password),
    isAdmin: body.isAdmin ?? existing.isAdmin,
    upstreamIds: body.upstreamIds === undefined ? existing.upstreamIds : body.upstreamIds,
    canViewGlobalTelemetry: body.canViewGlobalTelemetry ?? existing.canViewGlobalTelemetry,
  };
  await repo.users.save(next);

  // Any password change kicks every other device the target user is logged in
  // on, preserving only the actor's current session. When the actor patches
  // someone else, that "current session" belongs to the actor and never
  // matches the target's rows, so the target is fully signed out. When the
  // actor patches themselves, the dashboard tab they're acting from stays
  // alive. API-key callers have no session at all, so the target loses every
  // session unconditionally.
  if (body.password !== undefined) {
    const sessionId = c.get('sessionId') as string | undefined;
    if (sessionId) await repo.sessions.deleteByUserIdExcept(id, sessionId);
    else await repo.sessions.deleteByUserId(id);
  }

  return c.json(userToWire(next));
};

export const deleteUser = async (c: Context) => {
  const id = parseUserId(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid user id' }, 400);
  const actorId = c.get('userId') as number;
  if (id === 1) return c.json({ error: 'user 1 cannot be deleted' }, 400);
  if (id === actorId) return c.json({ error: 'cannot delete yourself' }, 400);

  const repo = getRepo();
  const ok = await repo.users.softDelete(id);
  if (!ok) return c.json({ error: 'User not found' }, 404);

  await repo.apiKeys.softDeleteByUserId(id);
  await repo.sessions.deleteByUserId(id);
  return c.json({ ok: true });
};

export const changeOwnPassword = async (c: CtxWithJson<typeof changeOwnPasswordBody>) => {
  const sessionId = c.get('sessionId') as string | undefined;
  if (!sessionId) {
    return c.json({ error: 'Self-service password change requires a logged-in dashboard session' }, 400);
  }
  const userId = c.get('userId') as number;
  const { currentPassword, newPassword } = c.req.valid('json');
  const repo = getRepo();

  const user = await repo.users.getById(userId);
  if (!user?.passwordHash) return c.json({ error: 'Current password is incorrect' }, 401);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  await repo.users.save({ ...user, passwordHash: await hashPassword(newPassword) });
  await repo.sessions.deleteByUserIdExcept(userId, sessionId);
  return c.json({ ok: true });
};
