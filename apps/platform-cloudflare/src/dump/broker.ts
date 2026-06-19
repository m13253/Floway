import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Cloudflare-specific shape: the DO's own put() already fans out to every
// accepted WebSocket, so there is no separate publish path. The broker
// contract is satisfied by subscribe alone, which opens a hibernation-aware
// socket against the per-key DO.
export const createCloudflareDumpBroker = (
  ns: DurableObjectNamespace<KeyDumpDO>,
): DumpBroker => ({
  publish() {
    // No-op — fanout happens inside the DO.
  },
  async *subscribe(keyId, signal): AsyncIterable<DumpMetadata> {
    const stub = ns.get(ns.idFromName(keyId));
    const resp = await stub.fetch(
      new Request('https://do/ws', { headers: { upgrade: 'websocket' } }),
    );
    const ws = resp.webSocket;
    if (!ws) throw new Error('KeyDumpDO did not return a WebSocket');
    ws.accept();

    const queue: DumpMetadata[] = [];
    let closed = false;
    let resolveNext: (() => void) | null = null;
    const wake = (): void => {
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    ws.addEventListener('message', e => {
      const data = typeof e.data === 'string'
        ? e.data
        : new TextDecoder().decode(e.data as ArrayBuffer);
      queue.push(JSON.parse(data) as DumpMetadata);
      wake();
    });
    const markClosed = (): void => { closed = true; wake(); };
    ws.addEventListener('close', markClosed);
    ws.addEventListener('error', markClosed);
    // { once: true } only auto-removes after the listener fires. If the
    // iterator returns normally (not via abort) on a shared signal that
    // outlives this call, the listener would otherwise accumulate.
    signal.addEventListener('abort', wake, { once: true });

    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          // The socket can close from the server side (DO eviction, retention
          // turned off mid-session). Exit once the queue is drained so the SSE
          // handler closes its end instead of hanging on an awaited promise
          // that will never resolve.
          if (closed) return;
          await new Promise<void>(resolve => { resolveNext = resolve; });
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      signal.removeEventListener('abort', wake);
      try { ws.close(); } catch {}
    }
  },
});
