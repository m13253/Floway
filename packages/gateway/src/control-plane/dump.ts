import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { ownedKeyOr404 } from './shared/owned-key.ts';
import { getDumpBroker, getDumpStore } from '../runtime/dump.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

const RECORDS_LIST_HARD_CAP = 200;
const RECORDS_LIST_DEFAULT = 100;
const STREAM_INITIAL_SNAPSHOT_LIMIT = 100;

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
    let brokerError: unknown = null;
    let sink: (meta: DumpMetadata) => void | Promise<void> = meta => { buffered.push(meta); };
    const pump = (async () => {
      try {
        for await (const meta of subscription) await sink(meta);
      } catch (err) {
        brokerError = err;
        console.error('[dump-stream]', keyId, err);
      }
    })();

    const snapshot = await getDumpStore().list(keyId, { limit: STREAM_INITIAL_SNAPSHOT_LIMIT });

    return streamSSE(c, async stream => {
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      while (buffered.length > 0) {
        const meta = buffered.shift()!;
        await stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
      }
      // Hand the broker pump its real sink. Reassigning `sink` between the
      // drain and `await pump` is atomic across this synchronous gap: V8
      // cannot interleave a broker push here because the pump's `await sink`
      // can only resume on a later microtask, by which time the live sink is
      // in place. The pump awaits each sink call, so writeSSE keeps ordering
      // and backpressure intact.
      sink = meta => stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
      await pump;
      // A broker failure (the iterator threw, not just signal-aborted) emits
      // one final `event: error` SSE frame so the dashboard sees a reason
      // instead of an opaque disconnect; the SSE close that follows then
      // stops the autoreconnect loop with context.
      if (brokerError !== null) {
        const message = brokerError instanceof Error ? brokerError.message : String(brokerError);
        await stream.writeSSE({ event: 'error', data: message });
      }
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
