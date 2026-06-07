// GET /api/token-usage — query per-key or per-user token usage records.
//
// The `view` query parameter selects between two shapes: `self-by-key` returns
// the actor's own keys, while `all-by-user` aggregates across users for admins
// and users granted the `canViewGlobalTelemetry` flag. The default view is
// determined by capability: callers who can see global telemetry default to
// all-by-user, everyone else to self-by-key.

import { aggregateUsageByUserForDisplay, aggregateUsageForDisplay } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { tokenUsageQuery } from '../schemas.ts';
import { resolveTelemetryView } from '../telemetry-view.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

export const tokenUsage = async (c: CtxWithQuery<typeof tokenUsageQuery>) => {
  const query = c.req.valid('query');
  const start = query.start ?? '';
  const end = query.end ?? '';
  if (!start || !end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400);
  }

  const resolved = resolveTelemetryView(c, query.view, query.key_id);
  if ('error' in resolved) {
    return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);
  }

  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    const [rawRecords, users, keys] = await Promise.all([
      repo.usage.query({ start, end }),
      repo.users.listIncludingDeleted(),
      repo.apiKeys.list(),
    ]);
    const keyToUser = new Map(keys.map(k => [k.id, k.userId] as const));
    const records = aggregateUsageByUserForDisplay(rawRecords, keyToUser);

    if (query.include_user_metadata !== '1') return c.json(records);
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username, deletedAt: u.deletedAt }))
      .sort((a, b) => a.id - b.id);
    return c.json({ records, users: userMetadata, keyColorOrder: USAGE_KEY_COLOR_ORDER });
  }

  // self-by-key: scope rows to the actor's keys (active + soft-deleted).
  const ownedIds = await repo.apiKeys.idsByUserId(resolved.scopeUserId!, { includeDeleted: true });
  const ownedSet = new Set(ownedIds);
  const explicitKeyId = query.key_id === '' ? undefined : query.key_id;
  if (explicitKeyId !== undefined && !ownedSet.has(explicitKeyId)) {
    return c.json({ error: 'Unknown key_id' }, 404);
  }

  const [rawRecords, keys] = await Promise.all([
    repo.usage.query({ keyId: explicitKeyId, start, end }),
    repo.apiKeys.listByUserId(resolved.scopeUserId!),
  ]);
  const filtered = explicitKeyId ? rawRecords : rawRecords.filter(r => ownedSet.has(r.keyId));
  const records = aggregateUsageForDisplay(filtered);

  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = records.map(r => ({
    ...r,
    keyName: keyMap.get(r.keyId)?.name ?? r.keyId.slice(0, 8),
    keyCreatedAt: keyMap.get(r.keyId)?.createdAt ?? null,
  }));

  if (query.include_key_metadata !== '1') return c.json(recordsWithKeyMetadata);

  const keyMetadata = keys
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
  });
};
