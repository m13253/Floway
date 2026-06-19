import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { getRepo } from '../repo/index.ts';
import type { ApiKey } from '../repo/types.ts';
import { getDumpBroker, getDumpStore } from '../runtime/dump.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

const RECORDS_LIST_HARD_CAP = 200;
const RECORDS_LIST_DEFAULT = 100;
const STREAM_INITIAL_SNAPSHOT_LIMIT = 100;

const ownedKeyOr404 = async (c: Context, keyId: string): Promise<ApiKey | Response> => {
  const userId = c.get('userId') as number;
  const key = await getRepo().apiKeys.getById(keyId);
  // Returning 404 (not 403) on foreign or unknown keys avoids leaking the
  // existence of another user's key id to the actor.
  if (key?.userId !== userId) return c.json({ error: 'Key not found' }, 404);
  return key;
};

// Missing → default. Garbage or non-positive → null so the caller rejects
// with 400 rather than silently substituting a value the operator did not
// ask for. Over-cap is clamped: the cap is the upper bound, not a hint that
// the input itself was invalid.
const parseLimit = (raw: string | undefined): number | null => {
  if (raw === undefined) return RECORDS_LIST_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), RECORDS_LIST_HARD_CAP);
};

export const dump = new Hono()
  .get('/keys/:keyId/stream', async c => {
    const keyId = c.req.param('keyId')!;
    const owned = await ownedKeyOr404(c, keyId);
    if (owned instanceof Response) return owned;

    // Subscribe FIRST and buffer broker pushes, then read the snapshot, then
    // drain the buffer to the client. A record completing between subscribe
    // and snapshot is delivered by both paths and the client dedupes by id —
    // at-worst-twice beats the alternative of a silent gap.
    const subscription = getDumpBroker().subscribe(keyId, c.req.raw.signal);
    const buffered: DumpMetadata[] = [];
    let sink: (meta: DumpMetadata) => void | Promise<void> = meta => { buffered.push(meta); };
    const pump = (async () => {
      try {
        for await (const meta of subscription) await sink(meta);
      } catch (err) {
        console.error('[dump-stream]', err);
      }
    })();

    const snapshot = await getDumpStore().list(keyId, { limit: STREAM_INITIAL_SNAPSHOT_LIMIT });

    return streamSSE(c, async stream => {
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      while (buffered.length > 0) {
        const meta = buffered.shift()!;
        await stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
      }
      // Hand the broker pump its real sink. The pump awaits each sink call,
      // so writeSSE keeps ordering and backpressure intact.
      sink = meta => stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
      await pump;
    });
  })
  .get('/keys/:keyId/records', async c => {
    const keyId = c.req.param('keyId')!;
    const owned = await ownedKeyOr404(c, keyId);
    if (owned instanceof Response) return owned;

    const before = c.req.query('before');
    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) return c.json({ error: '`limit` must be a positive integer' }, 400);
    const records = await getDumpStore().list(
      keyId,
      { limit, ...(before !== undefined ? { before } : {}) },
    );
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const keyId = c.req.param('keyId')!;
    const recordId = c.req.param('recordId')!;
    const owned = await ownedKeyOr404(c, keyId);
    if (owned instanceof Response) return owned;

    const record = await getDumpStore().get(keyId, recordId);
    if (record === null) return c.json({ error: 'Record not found' }, 404);
    return c.json(record);
  });
