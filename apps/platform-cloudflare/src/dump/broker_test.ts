import { test } from 'vitest';

import { createCloudflareDumpBroker } from './broker.ts';
import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assert, assertEquals } from '@floway-dev/test-utils';

// Minimal WebSocket-like double — enough surface for the broker subscribe
// loop. Uses a plain EventTarget under the hood so dispatchEvent + add/remove
// listeners behave like a workerd-style WebSocket without pulling in the real
// runtime.
class FakeWebSocket extends EventTarget {
  accept(): void { /* runtime no-op outside the DO host */ }
  close(): void { this.dispatchEvent(new Event('close')); }

  pushMessage(payload: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: payload }));
  }

  serverClose(): void {
    this.dispatchEvent(new Event('close'));
  }
}

const fakeNamespace = (ws: FakeWebSocket): DurableObjectNamespace<KeyDumpDO> => ({
  idFromName: name => ({ name }),
  get: () => ({
    fetch: async () => ({ webSocket: ws }) as unknown as Response,
  }) as unknown as DurableObjectStub & KeyDumpDO,
});

const meta = (id: string): DumpMetadata => ({
  id,
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_000_010,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: 10,
  error: null,
});

test('subscribe yields published metadata in order then exits when the server closes the socket', async () => {
  const ws = new FakeWebSocket();
  const broker = createCloudflareDumpBroker(fakeNamespace(ws));
  const controller = new AbortController();

  const received: DumpMetadata[] = [];
  const subscriber = (async () => {
    for await (const m of broker.subscribe('key1', controller.signal)) {
      received.push(m);
    }
  })();

  // Allow the subscribe generator to attach its listeners before we publish.
  await Promise.resolve();
  ws.pushMessage(JSON.stringify(meta('a')));
  ws.pushMessage(JSON.stringify(meta('b')));

  // Server-initiated close (DO eviction, retention turned off mid-session).
  // Without the closed-flag fix this hangs forever inside the await.
  await new Promise(resolve => setTimeout(resolve, 5));
  ws.serverClose();

  // Bound the wait — the iterator must end on its own; if it doesn't, the
  // race below keeps the test from hanging indefinitely so the failure mode
  // is a clear timeout assertion instead of a Vitest-level deadlock.
  const ended = await Promise.race([
    subscriber.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  assert(ended, 'subscribe should return after the server-side WebSocket close');
  assertEquals(received.map(m => m.id), ['a', 'b']);
});
