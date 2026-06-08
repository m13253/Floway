import type { Context } from 'hono';

import { userToRawWire } from './wire.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import { hashPassword, verifyPassword } from '../../shared/passwords.ts';
import type { changeOwnPasswordBody, createUserBody, updateUserBody } from '../schemas.ts';

const validateUpstreamIdsExist = async (ids: readonly string[] | null): Promise<string | null> => {
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
  return c.json(users.map(userToRawWire));
};

export const createUser = async (c: CtxWithJson<typeof createUserBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();

  if (await repo.users.findByUsernameActive(body.username)) {
    return c.json({ error: 'username taken' }, 400);
  }
  const upstreamErr = await validateUpstreamIdsExist(body.upstreamIds ?? null);
  if (upstreamErr) return c.json({ error: upstreamErr }, 400);

  // Includes soft-deleted rows so a recreated username never collides with
  // an old id.
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

  const defaultKey: ApiKey = {
    id: crypto.randomUUID(),
    userId: newId,
    name: 'Default',
    key: generateApiKeyToken(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
    deletedAt: null,
  };
  await repo.apiKeys.save(defaultKey);

  return c.json({ user: userToRawWire(user) }, 201);
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
    const err = await validateUpstreamIdsExist(body.upstreamIds);
    if (err) return c.json({ error: err }, 400);
  }

  const next: User = {
    ...existing,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    username: body.username === undefined ? existing.username : body.username,
    passwordHash: body.password === undefined ? existing.passwordHash : await hashPassword(body.password),
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    isAdmin: body.isAdmin === undefined ? existing.isAdmin : body.isAdmin,
    upstreamIds: body.upstreamIds === undefined ? existing.upstreamIds : body.upstreamIds,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    canViewGlobalTelemetry: body.canViewGlobalTelemetry === undefined ? existing.canViewGlobalTelemetry : body.canViewGlobalTelemetry,
  };
  await repo.users.save(next);

  // A password change revokes every session for the target user except the
  // actor's own. API-key callers have no session, so the target loses all.
  if (body.password !== undefined) {
    const sessionId = c.get('sessionId') as string | undefined;
    if (sessionId) await repo.sessions.deleteByUserIdExcept(id, sessionId);
    else await repo.sessions.deleteByUserId(id);
  }

  return c.json(userToRawWire(next));
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
  if (!user) throw new Error(`userId ${userId} in context but user row missing`);
  if (user.passwordHash === null) return c.json({ error: 'Current password is incorrect' }, 401);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  await repo.users.save({ ...user, passwordHash: await hashPassword(newPassword) });
  await repo.sessions.deleteByUserIdExcept(userId, sessionId);
  return c.json({ ok: true });
};
