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
    ws.addEventListener('close', wake);
    ws.addEventListener('error', wake);
    signal.addEventListener('abort', wake, { once: true });

    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => { resolveNext = resolve; });
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      try { ws.close(); } catch { /* socket already closed */ }
    }
  },
});
