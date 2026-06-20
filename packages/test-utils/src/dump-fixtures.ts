import type { DumpBroker, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord } from '@floway-dev/protocols/dump';

export const fakeMeta = (overrides: Partial<DumpMetadata> = {}): DumpMetadata => ({
  id: 'test-id',
  startedAt: 0,
  completedAt: 1,
  method: 'POST',
  path: '/v1/x',
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 1,
  error: null,
  ...overrides,
});

export const fakeRecord = (overrides: Partial<DumpMetadata> = {}): DumpRecord => ({
  meta: fakeMeta(overrides),
  request: { method: 'POST', path: '/v1/x', headers: [], body: { encoding: 'utf8', data: '' } },
  response: { status: 200, headers: [], type: 'none' },
});

// Shared in-memory stubs for the dump store + broker. Used by every dump
// test that needs a controllable pair: the control-plane SSE route tests,
// the capture middleware tests, the cascade-safety tests.
export interface DumpStubHandle {
  store: DumpStore;
  broker: DumpBroker;
  stored: ReadonlyArray<{ keyId: string; record: DumpRecord }>;
  published: ReadonlyArray<{ keyId: string; meta: DumpMetadata }>;
  purgedAll: ReadonlyArray<string>;
  purgedExpired: ReadonlyArray<{ keyId: string; retentionSeconds: number }>;
  notifiedDisabled: ReadonlyArray<string>;
  seed: (keyId: string, record: DumpRecord) => void;
  publish: (keyId: string, meta: DumpMetadata) => Promise<void>;
  failPut: (err: Error) => void;
  failPublish: (err: Error) => void;
  failPurgeAll: (err: Error) => void;
  failPurgeExpired: (err: Error) => void;
  failNotifyDisabled: (err: Error) => void;
}

export const createDumpStubs = (): DumpStubHandle => {
  const records = new Map<string, DumpRecord[]>();
  const subscribers = new Map<string, Array<(meta: DumpMetadata | null) => void>>();
  const stored: Array<{ keyId: string; record: DumpRecord }> = [];
  const published: Array<{ keyId: string; meta: DumpMetadata }> = [];
  const purgedAll: string[] = [];
  const purgedExpired: Array<{ keyId: string; retentionSeconds: number }> = [];
  const notifiedDisabled: string[] = [];
  let putThrows: Error | null = null;
  let publishThrows: Error | null = null;
  let purgeAllThrows: Error | null = null;
  let purgeExpiredThrows: Error | null = null;
  let notifyDisabledThrows: Error | null = null;

  const store: DumpStore = {
    async put(keyId, record) {
      if (putThrows) throw putThrows;
      stored.push({ keyId, record });
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    async list(keyId, opts) {
      const list = records.get(keyId) ?? [];
      let start = 0;
      if (opts.before) {
        const idx = list.findIndex(r => r.meta.id === opts.before);
        start = idx >= 0 ? idx + 1 : list.length;
      }
      return list.slice(start, start + opts.limit).map(r => r.meta);
    },
    async get(keyId, id) {
      return (records.get(keyId) ?? []).find(r => r.meta.id === id) ?? null;
    },
    async purgeAll(keyId) {
      if (purgeAllThrows) throw purgeAllThrows;
      purgedAll.push(keyId);
      records.delete(keyId);
    },
    async purgeExpired(keyId, retentionSeconds) {
      if (purgeExpiredThrows) throw purgeExpiredThrows;
      purgedExpired.push({ keyId, retentionSeconds });
    },
  };

  const broker: DumpBroker = {
    async publish(keyId, meta) {
      if (publishThrows) throw publishThrows;
      published.push({ keyId, meta });
      for (const fn of subscribers.get(keyId) ?? []) fn(meta);
    },
    async notifyDisabled(keyId) {
      if (notifyDisabledThrows) throw notifyDisabledThrows;
      notifiedDisabled.push(keyId);
      for (const fn of subscribers.get(keyId) ?? []) fn(null);
    },
    subscribe(keyId, signal) {
      // Eager listener registration mirrors production: a publish between
      // subscribe() and the iterator's first read still lands in the queue.
      const queue: DumpMetadata[] = [];
      let resolveNext: ((v: IteratorResult<DumpMetadata>) => void) | null = null;
      let closed = false;
      const onMeta = (meta: DumpMetadata | null): void => {
        if (closed) return;
        if (meta === null) {
          closed = true;
          if (resolveNext) { resolveNext({ value: undefined as never, done: true }); resolveNext = null; }
          return;
        }
        if (resolveNext) { resolveNext({ value: meta, done: false }); resolveNext = null; } else queue.push(meta);
      };
      const list = subscribers.get(keyId) ?? [];
      list.push(onMeta);
      subscribers.set(keyId, list);
      signal.addEventListener('abort', () => onMeta(null), { once: true });
      const detach = (): void => {
        const next = (subscribers.get(keyId) ?? []).filter(fn => fn !== onMeta);
        if (next.length === 0) subscribers.delete(keyId);
        else subscribers.set(keyId, next);
      };
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
          async next() {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (closed) { detach(); return { value: undefined as never, done: true }; }
            const v = await new Promise<IteratorResult<DumpMetadata>>(r => { resolveNext = r; });
            if (v.done) detach();
            return v;
          },
          async return() { closed = true; detach(); return { value: undefined as never, done: true }; },
        }),
      };
    },
  };

  return {
    store,
    broker,
    stored,
    published,
    purgedAll,
    purgedExpired,
    notifiedDisabled,
    seed: (keyId, record) => {
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    publish: (keyId, meta) => broker.publish(keyId, meta),
    failPut: err => { putThrows = err; },
    failPublish: err => { publishThrows = err; },
    failPurgeAll: err => { purgeAllThrows = err; },
    failPurgeExpired: err => { purgeExpiredThrows = err; },
    failNotifyDisabled: err => { notifyDisabledThrows = err; },
  };
};
