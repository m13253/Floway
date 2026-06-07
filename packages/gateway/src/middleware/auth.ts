import type { Context, Next } from 'hono';

import { getRepo } from '../repo/index.ts';
import { getEnv } from '@floway-dev/platform';

// `/` and `/dashboard` are served by Workers Static Assets (apps/web/dist)
// before reaching the Worker. `/favicon.ico` is reserved for a future static
// favicon at apps/web/src/favicon.ico; until that file lands and is copied into
// dist/, the Worker handles it as a public 204 (see control-plane/routes.ts).
const PUBLIC_PATHS = new Set(['/api/health', '/favicon.ico']);
const AUTH_VALIDATE_PATHS = new Set(['/auth/login']);

export const authMiddleware = async (c: Context, next: Next) => {
  const path = c.req.path;
  if (PUBLIC_PATHS.has(path) && c.req.method === 'GET') return await next();
  if (AUTH_VALIDATE_PATHS.has(path) && c.req.method === 'POST') return await next();

  const sessionToken = c.req.header('x-floway-session');
  if (sessionToken) {
    if (!(path.startsWith('/api/') || path.startsWith('/auth/'))) {
      return c.json({ error: 'Session tokens are only valid on dashboard routes; data-plane requests must use an API key.' }, 401);
    }
    const session = await getRepo().sessions.getByIdAndTouch(sessionToken);
    if (!session) return c.json({ error: 'Invalid session' }, 401);
    const user = await getRepo().users.getById(session.userId);
    if (!user) {
      // The user was deleted while this session was live; clean it up so the
      // next request stops paying for the lookup.
      await getRepo().sessions.deleteById(sessionToken);
      return c.json({ error: 'Invalid session' }, 401);
    }
    setUserContext(c, user);
    c.set('sessionId', sessionToken);
    return await next();
  }

  const rawKey = extractApiKey(c);
  if (!rawKey) return c.json({ error: 'Unauthorized' }, 401);

  const adminKey = getEnv('ADMIN_KEY');
  if (adminKey && rawKey === adminKey) {
    return c.json({ error: 'ADMIN_KEY is only valid via POST /auth/login (leave username blank).' }, 401);
  }

  const apiKey = await getRepo().apiKeys.findByRawKey(rawKey);
  if (!apiKey) return c.json({ error: 'Unauthorized' }, 401);
  const user = await getRepo().users.getById(apiKey.userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  setUserContext(c, user);
  c.set('apiKeyId', apiKey.id);
  c.set('apiKeyUpstreamIds', apiKey.upstreamIds);
  await next();
};

const setUserContext = (
  c: Context,
  user: { id: number; isAdmin: boolean; upstreamIds: string[] | null; canViewGlobalTelemetry: boolean },
) => {
  c.set('userId', user.id);
  c.set('isAdmin', user.isAdmin);
  c.set('userUpstreamIds', user.upstreamIds);
  c.set('canViewGlobalTelemetry', user.isAdmin || user.canViewGlobalTelemetry);
};

const extractApiKey = (c: Context): string | null => {
  const url = new URL(c.req.url);
  return url.searchParams.get('key')
    ?? c.req.header('x-api-key')
    ?? c.req.header('x-goog-api-key')
    ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    ?? null;
};

export const userUpstreamIdsFromContext = (c: Context): readonly string[] | null =>
  (c.get('userUpstreamIds') as readonly string[] | null | undefined) ?? null;

// Composes the per-user upstream cap with the per-key whitelist: any side `null`
// means unrestricted; both sides set return their intersection (preserving the
// per-key priority order). Empty intersection reaches the existing
// "no upstream available" error path.
export const effectiveUpstreamIdsFromContext = (c: Context): readonly string[] | null => {
  const userIds = userUpstreamIdsFromContext(c);
  const keyIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  if (userIds === null && keyIds === null) return null;
  if (userIds === null) return keyIds;
  if (keyIds === null) return userIds;
  const userSet = new Set(userIds);
  return keyIds.filter(id => userSet.has(id));
};
