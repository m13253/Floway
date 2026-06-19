import { onScopeDispose, ref, watch, type Ref } from 'vue';

import type { DumpMetadata } from '@floway-dev/protocols/dump';

const PAGE_SIZE = 100;

interface ListResponse {
  records: DumpMetadata[];
}

// Open a single EventSource against /api/dump/keys/<id>/stream and expose the
// running record list. `snapshot` is treated as ground truth on every arrival
// (including the browser's silent auto-reconnect, which fires snapshot again
// without us calling open) — the list is rebuilt and the seen-set is reset
// from the new snapshot. `appended` prepends individual rows, deduped via the
// seen-set so the snapshot/subscribe race in the gateway (where a record
// completed in the small window between read-snapshot and subscribe is
// intentionally allowed to surface twice) collapses to one row.
export const useDumpSubscription = (keyId: Ref<string>) => {
  const records = ref<DumpMetadata[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let seen = new Set<string>();
  let source: EventSource | null = null;

  const closeSource = () => {
    source?.close();
    source = null;
  };

  const open = (id: string) => {
    closeSource();
    records.value = [];
    seen = new Set();
    loading.value = true;
    error.value = null;

    const es = new EventSource(`/api/dump/keys/${encodeURIComponent(id)}/stream`);
    source = es;

    es.addEventListener('snapshot', ev => {
      const data = JSON.parse((ev as MessageEvent).data) as DumpMetadata[];
      seen = new Set(data.map(meta => meta.id));
      records.value = [...data];
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
    const res = await fetch(url);
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
