import { onScopeDispose, ref, watch, type Ref } from 'vue';

import { authFetch } from '../api/client.ts';
import { useAuthStore } from '../stores/auth.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

const PAGE_SIZE = 100;

interface ListResponse {
  records: DumpMetadata[];
}

// Open a single EventSource against /api/dump/keys/<id>/stream and expose the
// running record list. `snapshot` covers the newest N records and is
// authoritative for that window; on every arrival (including the browser's
// silent auto-reconnect, which re-fires snapshot without us calling open) we
// rebuild the list from the new snapshot but preserve any records older than
// the snapshot's oldest entry — otherwise a transient disconnect would
// silently discard everything the user paged in via `loadOlder`. `appended`
// prepends individual rows, deduped via the seen-set so the snapshot/subscribe
// race in the gateway (where a record completed in the small window between
// read-snapshot and subscribe is intentionally allowed to surface twice)
// collapses to one row.
export const useDumpSubscription = (keyId: Ref<string>) => {
  const auth = useAuthStore();
  const records = ref<DumpMetadata[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const seen = new Set<string>();
  let source: EventSource | null = null;

  const closeSource = () => {
    source?.close();
    source = null;
  };

  const open = (id: string) => {
    closeSource();
    records.value = [];
    seen.clear();
    loading.value = true;
    error.value = null;

    // Browsers cannot set custom headers on EventSource, so the SSE endpoint
    // accepts the session token as a query string. See auth middleware.
    const token = auth.authToken;
    const url = `/api/dump/keys/${encodeURIComponent(id)}/stream`
      + (token ? `?session=${encodeURIComponent(token)}` : '');
    const es = new EventSource(url);
    source = es;

    es.addEventListener('snapshot', ev => {
      const data = JSON.parse((ev as MessageEvent).data) as DumpMetadata[];
      // Records are sorted newest-first; ULID ids encode time, so id-comparison
      // is equivalent to a startedAt comparison and avoids touching meta fields.
      const snapshotOldestId = data.length > 0 ? data[data.length - 1]!.id : null;
      const preserved = snapshotOldestId !== null
        ? records.value.filter(r => r.id < snapshotOldestId)
        : [];
      seen.clear();
      const merged = [...data, ...preserved];
      for (const meta of merged) seen.add(meta.id);
      records.value = merged;
      loading.value = false;
    });

    es.addEventListener('appended', ev => {
      const meta = JSON.parse((ev as MessageEvent).data) as DumpMetadata;
      if (seen.has(meta.id)) return;
      seen.add(meta.id);
      records.value = [meta, ...records.value];
    });

    es.addEventListener('error', () => {
      // EventSource autoreconnects; surface the disconnect once so the UI
      // can show "reconnecting…" without flickering on every retry.
      if (es.readyState === EventSource.CLOSED) {
        error.value = 'Stream disconnected';
        loading.value = false;
      }
    });
  };

  const loadOlder = async () => {
    const oldest = records.value.at(-1);
    if (!oldest) return;
    const url = `/api/dump/keys/${encodeURIComponent(keyId.value)}/records?before=${encodeURIComponent(oldest.id)}&limit=${PAGE_SIZE}`;
    const res = await authFetch(url);
    if (!res.ok) {
      error.value = `Failed to load older records: HTTP ${res.status}`;
      return;
    }
    const body = await res.json() as ListResponse;
    const fresh: DumpMetadata[] = [];
    for (const meta of body.records) {
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      fresh.push(meta);
    }
    if (fresh.length) records.value = [...records.value, ...fresh];
  };

  watch(keyId, id => open(id), { immediate: true });
  onScopeDispose(closeSource);

  return { records, loading, error, loadOlder };
};
