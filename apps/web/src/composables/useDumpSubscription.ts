import { onScopeDispose, ref, watch, type Ref } from 'vue';

import { authFetch } from '../api/client.ts';
import { useAuthStore } from '../stores/auth.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Bound the dedup set so a long-lived subscription doesn't accumulate ids
// forever. Comfortably above the snapshot limit and the typical "back-pressure
// during a burst" window; rebuild is cheap relative to the network roundtrip.
const DEDUP_REBUILD_THRESHOLD = 10_000;

// Re-fetched per page. Matches the server's LIST_LIMIT_DEFAULT.
const OLDER_PAGE_LIMIT = 100;

// `EventSource.CLOSED` is `2` per the HTML spec. We reach for the literal
// rather than the named property because happy-dom — the test environment —
// does not ship `EventSource` on the global scope, so a reference at this
// line would crash with `EventSource is not defined` inside the listener.
const EVENT_SOURCE_CLOSED = 2;

interface DumpSubscription {
  records: Ref<DumpMetadata[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  loadOlder: () => Promise<void>;
}

interface SnapshotPayload {
  records: DumpMetadata[];
}

interface ServerErrorPayload {
  message: string;
}

interface ListResponse {
  records: DumpMetadata[];
}

// Test seam: vitest's `happy-dom` ships `EventSource`, but unit tests prefer
// to inject a controllable stub. The factory defaults to the global ctor.
type EventSourceFactory = (url: string) => EventSource;

export interface UseDumpSubscriptionOptions {
  eventSourceFactory?: EventSourceFactory;
  fetcher?: (url: string) => Promise<Response>;
}

const defaultFactory: EventSourceFactory = url => new EventSource(url);

export const useDumpSubscription = (
  keyId: Ref<string>,
  options: UseDumpSubscriptionOptions = {},
): DumpSubscription => {
  const factory = options.eventSourceFactory ?? defaultFactory;
  const fetcher = options.fetcher ?? authFetch;
  const auth = useAuthStore();

  const records = ref<DumpMetadata[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const seen = new Set<string>();

  let source: EventSource | null = null;
  let currentKeyId = '';

  const rebuildSeen = () => {
    seen.clear();
    for (const r of records.value) seen.add(r.id);
  };

  const close = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const reset = () => {
    close();
    records.value = [];
    seen.clear();
    error.value = null;
    loading.value = false;
    currentKeyId = '';
  };

  const handleSnapshot = (snapshot: DumpMetadata[]) => {
    // Preserve paged-in older history past the snapshot's tail. ULIDs are
    // lexically time-ordered, so a record older than the snapshot's oldest
    // id is exactly the one whose id sorts strictly less. This handles the
    // long-disconnect case where the user paged backward and the snapshot's
    // own oldest id is no longer in memory.
    const snapshotIds = new Set(snapshot.map(r => r.id));
    const oldestSnapshotId = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.id : null;
    const olderTail = oldestSnapshotId === null
      ? []
      : records.value.filter(r => !snapshotIds.has(r.id) && r.id < oldestSnapshotId);
    records.value = [...snapshot, ...olderTail];
    rebuildSeen();
    loading.value = false;
    // A successful (re)snapshot dismisses any stale transport-error banner.
    error.value = null;
  };

  const handleAppended = (meta: DumpMetadata) => {
    if (seen.has(meta.id)) return;
    records.value = [meta, ...records.value];
    seen.add(meta.id);
    // Order matters: rebuild after the prepend so it picks up the just-added id.
    if (seen.size > DEDUP_REBUILD_THRESHOLD) rebuildSeen();
  };

  const open = (id: string) => {
    close();
    currentKeyId = id;
    loading.value = true;
    error.value = null;
    // The composable is mounted only inside the authenticated dashboard
    // layout, so an empty authToken would be a routing wiring bug rather
    // than a runtime state — fail loud.
    const token = auth.authToken;
    if (!token) {
      throw new Error('useDumpSubscription invoked without an authenticated session');
    }
    const url = `/api/dump/keys/${encodeURIComponent(id)}/stream?session=${encodeURIComponent(token)}`;
    const es = factory(url);
    source = es;

    es.addEventListener('snapshot', ev => {
      const payload = JSON.parse((ev as MessageEvent).data) as SnapshotPayload;
      handleSnapshot(payload.records);
    });
    es.addEventListener('appended', ev => {
      const meta = JSON.parse((ev as MessageEvent).data) as DumpMetadata;
      handleAppended(meta);
    });
    es.addEventListener('error', rawEv => {
      const ev = rawEv as MessageEvent;
      // The server sends explicit `event: error` frames with a JSON body; the
      // browser dispatches those as `error` MessageEvents that carry `data`.
      // Native transport errors arrive on the same listener with empty data.
      if (typeof ev.data === 'string' && ev.data.length > 0) {
        let message = ev.data;
        try {
          const payload = JSON.parse(ev.data) as ServerErrorPayload;
          message = payload.message;
        } catch {
          // Non-JSON payload — surface verbatim so the broken-protocol case
          // doesn't render an empty error banner.
        }
        error.value = message;
        loading.value = false;
        // A server-sent error frame is terminal — stop the EventSource so the
        // browser doesn't keep auto-reconnecting against a stream the gateway
        // already gave up on. Selecting the key again reopens via the watcher.
        close();
        return;
      }
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        error.value = 'Stream disconnected';
        loading.value = false;
      }
    });
  };

  const loadOlder = async () => {
    if (currentKeyId === '') return;
    const oldest = records.value[records.value.length - 1];
    if (!oldest) return;
    const url = `/api/dump/keys/${encodeURIComponent(currentKeyId)}/records`
      + `?before=${encodeURIComponent(oldest.id)}&limit=${OLDER_PAGE_LIMIT}`;
    const res = await fetcher(url);
    if (!res.ok) {
      error.value = `Failed to load older records: HTTP ${res.status}`;
      return;
    }
    const body = (await res.json()) as ListResponse;
    if (body.records.length === 0) return;
    const fresh = body.records.filter(r => !seen.has(r.id));
    if (fresh.length === 0) return;
    records.value = [...records.value, ...fresh];
    for (const r of fresh) seen.add(r.id);
  };

  watch(keyId, id => {
    if (id === '') {
      reset();
      return;
    }
    // open() closes any prior socket via close(); a same-id watch fire
    // therefore reopens the stream, which is the recovery path after a
    // server-sent terminal error frame.
    records.value = [];
    seen.clear();
    open(id);
  }, { immediate: true });

  onScopeDispose(() => {
    close();
  });

  return { records, loading, error, loadOlder };
};
