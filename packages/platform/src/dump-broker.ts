import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Real-time fan-out from the data plane (which captures records) to the
// dashboard SSE subscribers. Implementations live in the platform-target
// apps: Cloudflare wraps a per-key BroadcastDO (a generic WS fan-out actor)
// over WebSocket Hibernation; Node uses an in-process EventTarget per key.
//
// The broker is intentionally separate from the DumpStore. The store owns
// durable state; the broker only relays the "a new record just landed"
// event. A subscriber that disconnects and reconnects rebuilds its view
// from the store's snapshot — the broker does not retain history.

export interface DumpBroker {
  // Called by the capture finalize path after the DumpStore.put has
  // succeeded and the metadata row is committed. The publish itself is best-
  // effort: a subscriber that misses the live frame will see the record
  // on its next snapshot fetch (the store is the source of truth).
  publish(keyId: string, meta: DumpMetadata): Promise<void>;

  // Returns an async iterable that yields each `meta` published while the
  // iterator is active. The iterator ends when `signal` aborts or the
  // underlying transport closes. Subscribers must wire the iterator into
  // their SSE stream and bail on iterator completion. Implementations may
  // surface transport failures by throwing from `.next()`; callers must
  // catch and translate to an SSE `event: error` frame so the dashboard
  // sees a structured signal instead of a torn TCP socket.
  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata>;

  // Disable-side notification hook. Called from api-key PATCH retention=null,
  // api-key delete, and the user-delete cascade. The DO/EventTarget closes its
  // open sockets so clients see a clean disconnect and the dashboard's
  // reconcile-on-keys-refetch path tears down the now-orphan stream.
  notifyDisabled(keyId: string): Promise<void>;
}
