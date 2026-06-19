import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { getRepo } from '../repo/index.ts';
import { getDumpBroker, getDumpStore } from '../runtime/dump.ts';

const RECORDS_LIST_HARD_CAP = 200;
const STREAM_INITIAL_SNAPSHOT_LIMIT = 100;

const ownedKeyOr404 = async (c: Context, keyId: string): Promise<true | Response> => {
  const userId = c.get('userId') as number;
  const key = await getRepo().apiKeys.getById(keyId);
  // Returning 404 (not 403) on foreign or unknown keys avoids leaking the
  // existence of another user's key id to the actor.
  if (key?.userId !== userId) return c.json({ error: 'Key not found' }, 404);
  return true;
};

const parseLimit = (raw: string | undefined): number => {
  if (raw === undefined) return RECORDS_LIST_HARD_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RECORDS_LIST_HARD_CAP;
  return Math.min(Math.floor(n), RECORDS_LIST_HARD_CAP);
};

export const dump = new Hono()
  .get('/keys/:keyId/stream', async c => {
    const keyId = c.req.param('keyId')!;
    const ownership = await ownedKeyOr404(c, keyId);
    if (ownership !== true) return ownership;

    // Snapshot must be read before subscribe so a record completed in the
    // small window between is at worst seen twice (the dashboard dedupes by
    // id); skipping subscribe-first would risk missing a record entirely.
    const snapshot = await getDumpStore().list(keyId, { limit: STREAM_INITIAL_SNAPSHOT_LIMIT });

    return streamSSE(c, async stream => {
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      for await (const meta of getDumpBroker().subscribe(keyId, c.req.raw.signal)) {
        await stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
      }
    });
  })
  .get('/keys/:keyId/records', async c => {
    const keyId = c.req.param('keyId')!;
    const ownership = await ownedKeyOr404(c, keyId);
    if (ownership !== true) return ownership;

    const before = c.req.query('before');
    const limit = parseLimit(c.req.query('limit'));
    const records = await getDumpStore().list(keyId, {
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const keyId = c.req.param('keyId')!;
    const recordId = c.req.param('recordId')!;
    const ownership = await ownedKeyOr404(c, keyId);
    if (ownership !== true) return ownership;

    const record = await getDumpStore().get(keyId, recordId);
    if (record === null) return c.json({ error: 'Record not found' }, 404);
    return c.json(record);
  });
