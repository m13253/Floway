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
    // Preserve any paged-in older history past the snapshot's tail so a
    // transient reconnect doesn't wipe what the user already scrolled to.
    const oldestSnapshotId = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.id : null;
    const snapshotIds = new Set(snapshot.map(r => r.id));
    const olderTail: DumpMetadata[] = [];
    if (oldestSnapshotId !== null) {
      let crossed = false;
      for (const existing of records.value) {
        if (existing.id === oldestSnapshotId) {
          crossed = true;
          continue;
        }
        if (crossed && !snapshotIds.has(existing.id)) olderTail.push(existing);
      }
    }
    records.value = [...snapshot, ...olderTail];
    rebuildSeen();
    loading.value = false;
    // Successful (re)snapshot dismisses any stale transport-error banner.
    error.value = null;
  };

  const handleAppended = (meta: DumpMetadata) => {
    if (seen.has(meta.id)) return;
    records.value = [meta, ...records.value];
    seen.add(meta.id);
    // Order matters: the just-added id is now in `records.value`, so rebuild
    // sees it. Doing this before the prepend would drop the new id from `seen`.
    if (seen.size > DEDUP_REBUILD_THRESHOLD) rebuildSeen();
  };

  const open = (id: string) => {
    close();
    currentKeyId = id;
    loading.value = true;
    error.value = null;
    const token = auth.authToken;
    if (!token) {
      error.value = 'Not authenticated';
      loading.value = false;
      return;
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
        try {
          const payload = JSON.parse(ev.data) as ServerErrorPayload;
          error.value = payload.message;
        } catch {
          error.value = ev.data;
        }
        loading.value = false;
        return;
      }
      // `EventSource.CLOSED === 2`; use the literal so the composable doesn't
      // require a globally-defined `EventSource` in the unit-test environment.
      if (es.readyState === 2) {
        error.value = 'Stream disconnected';
        loading.value = false;
      }
      // Intermediate readyState (CONNECTING) means the browser is reconnecting
      // on its own — staying quiet avoids a flicker for every blip.
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
    if (id === currentKeyId) return;
    records.value = [];
    seen.clear();
    open(id);
  }, { immediate: true });

  onScopeDispose(() => {
    close();
  });

  return { records, loading, error, loadOlder };
};
