// Auth routes — username/password login with an ADMIN_KEY backdoor for the
// seed admin (user 1). Sessions are issued as opaque 64-hex tokens carried
// on the `x-floway-session` header.

import type { Context } from 'hono';

import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { User } from '../../repo/types.ts';
import { verifyPassword } from '../../shared/passwords.ts';
import type { authLoginBody } from '../schemas.ts';
import { getEnv } from '@floway-dev/platform';

// /auth/me feeds the dashboard its effective capability flags, so isAdmin is
// OR'd into canViewGlobalTelemetry — admins always see global telemetry.
// Distinct from users/routes.ts userToWire, which surfaces the raw stored
// flags so an admin editing a user can see and toggle the underlying values.
const userToWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.isAdmin || user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
});

export const authLogin = async (c: CtxWithJson<typeof authLoginBody>) => {
  const { username, password } = c.req.valid('json');
  const repo = getRepo();

  if (username === '') {
    const adminKey = getEnv('ADMIN_KEY');
    if (!adminKey || password !== adminKey) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }
    const user = await repo.users.getById(1);
    if (!user) return c.json({ error: 'Invalid username or password' }, 401);
    const session = await repo.sessions.create(user.id);
    return c.json({ token: session.id, user: userToWire(user) });
  }

  const user = await repo.users.findByUsernameActive(username);
  if (!user?.passwordHash) return c.json({ error: 'Invalid username or password' }, 401);
  if (!(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  const session = await repo.sessions.create(user.id);
  return c.json({ token: session.id, user: userToWire(user) });
};

export const authLogout = async (c: Context) => {
  const sessionId = c.get('sessionId') as string | undefined;
  if (sessionId) await getRepo().sessions.deleteById(sessionId);
  return c.json({ ok: true });
};

export const authMe = async (c: Context) => {
  const userId = c.get('userId') as number;
  const sessionId = c.get('sessionId') as string | undefined;
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const user = await getRepo().users.getById(userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let apiKey: { id: string; name: string } | null = null;
  if (apiKeyId) {
    const k = await getRepo().apiKeys.getById(apiKeyId);
    apiKey = k ? { id: k.id, name: k.name } : null;
  }
  return c.json({
    user: userToWire(user),
    viaApiKey: !sessionId,
    apiKey,
  });
};
