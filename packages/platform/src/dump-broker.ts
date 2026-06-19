import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Per-key live pub-sub. Best-effort: a subscriber that disconnects misses
// messages sent while it was away. Recovery is via DumpStore.list.
export interface DumpBroker {
  // Fire-and-forget. Must never block the capture path.
  publish(keyId: string, meta: DumpMetadata): void;
  // Yields metadata as it is published. Returns when the signal aborts.
  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata>;
}
