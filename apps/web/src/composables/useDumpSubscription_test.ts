import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { useDumpSubscription } from './useDumpSubscription.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal EventSource fake. Reproduces the parts the composable touches:
// `addEventListener` for named events, `close`, the `readyState`/`CLOSED`
// pair, and a `dispatch` helper that tests use to deliver server-sent
// events. Track instances per URL so a test can simulate the browser's
// silent reconnect by reusing the same instance and re-emitting `snapshot`.
interface FakeEventSource {
  url: string;
  readyState: number;
  listeners: Map<string, Array<(ev: MessageEvent) => void>>;
  addEventListener: (type: string, fn: (ev: MessageEvent) => void) => void;
  close: () => void;
  dispatch: (event: string, data: unknown) => void;
}

const created: FakeEventSource[] = [];

const installEventSource = () => {
  created.length = 0;
  class EventSourceStub implements FakeEventSource {
    static readonly CLOSED = 2;
    url: string;
    readyState = 0;
    listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    constructor(url: string) {
      this.url = url;
      created.push(this);
    }
    addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    close(): void {
      this.readyState = EventSourceStub.CLOSED;
    }
    dispatch(event: string, data: unknown): void {
      const list = this.listeners.get(event) ?? [];
      const ev = { data: JSON.stringify(data) } as MessageEvent;
      for (const fn of list) fn(ev);
    }
  }
  vi.stubGlobal('EventSource', EventSourceStub);
};

const meta = (id: string, startedAt: number): DumpMetadata => ({
  id,
  startedAt,
  completedAt: startedAt + 10,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  upstream: { id: 'up_copilot', name: 'Copilot', kind: 'copilot' },
  model: 'm',
  inputTokens: 1,
  outputTokens: 2,
  requestBytes: 64,
  responseBytes: 128,
  durationMs: 10,
  error: null,
});

let scope: ReturnType<typeof effectScope> | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  scope = effectScope();
  installEventSource();
});

afterEach(() => {
  scope?.stop();
  scope = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = <T>(fn: () => T): T => {
  const v = scope!.run(fn);
  if (v === undefined) throw new Error('scope returned undefined');
  return v;
};

test('initial snapshot populates the record list newest-first', async () => {
  const sub = run(() => useDumpSubscription(ref('key1')));
  await nextTick();
  const es = created[0]!;
  const snapshot = [meta('01HXSNAP0000000000000C', 300), meta('01HXSNAP0000000000000B', 200), meta('01HXSNAP0000000000000A', 100)];
  es.dispatch('snapshot', snapshot);
  expect(sub.records.value.map(r => r.id)).toEqual(snapshot.map(r => r.id));
  expect(sub.loading.value).toBe(false);
});

test('loadOlder appends older records returned by /records', async () => {
  const sub = run(() => useDumpSubscription(ref('key1')));
  await nextTick();
  const es = created[0]!;
  const snapshot = [meta('01HXLOAD0000000000010Z', 1000), meta('01HXLOAD0000000000009Y', 900)];
  es.dispatch('snapshot', snapshot);
  const older = [meta('01HXLOAD0000000000008X', 800), meta('01HXLOAD0000000000007W', 700)];
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ records: older }) }));
  vi.stubGlobal('fetch', fetchMock);
  await sub.loadOlder();
  expect(sub.records.value.map(r => r.id)).toEqual([...snapshot, ...older].map(r => r.id));
  // The before-cursor is the current oldest record's id.
  expect(fetchMock.mock.calls[0]![0]).toContain('before=01HXLOAD0000000000009Y');
});

test('reconnect snapshot preserves records older than the new snapshot window', async () => {
  const sub = run(() => useDumpSubscription(ref('key1')));
  await nextTick();
  const es = created[0]!;
  const initial = [meta('01HXRECO0000000000010Z', 1000), meta('01HXRECO0000000000009Y', 900)];
  es.dispatch('snapshot', initial);
  const older = [meta('01HXRECO0000000000008X', 800), meta('01HXRECO0000000000007W', 700)];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: older }) })));
  await sub.loadOlder();
  expect(sub.records.value).toHaveLength(4);

  // Simulate browser auto-reconnect: same EventSource re-fires `snapshot`,
  // this time including a record completed during the disconnect window.
  const reconnected = [meta('01HXRECO0000000000011A', 1100), meta('01HXRECO0000000000010Z', 1000), meta('01HXRECO0000000000009Y', 900)];
  es.dispatch('snapshot', reconnected);
  // The two older loadOlder rows are below the new snapshot's oldest id and
  // must survive; the new snapshot replaces the overlapping window.
  expect(sub.records.value.map(r => r.id)).toEqual([
    '01HXRECO0000000000011A',
    '01HXRECO0000000000010Z',
    '01HXRECO0000000000009Y',
    '01HXRECO0000000000008X',
    '01HXRECO0000000000007W',
  ]);
});

test('appended after reconnect prepends and dedupes against preserved older rows', async () => {
  const sub = run(() => useDumpSubscription(ref('key1')));
  await nextTick();
  const es = created[0]!;
  es.dispatch('snapshot', [meta('01HXAPND0000000000010Z', 1000)]);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [meta('01HXAPND0000000000008X', 800)] }),
  })));
  await sub.loadOlder();

  es.dispatch('snapshot', [meta('01HXAPND0000000000010Z', 1000)]);
  // Preserved older row still there after reconnect.
  expect(sub.records.value.map(r => r.id)).toEqual(['01HXAPND0000000000010Z', '01HXAPND0000000000008X']);

  // A fresh appended event prepends.
  es.dispatch('appended', meta('01HXAPND0000000000012B', 1200));
  expect(sub.records.value.map(r => r.id)).toEqual([
    '01HXAPND0000000000012B',
    '01HXAPND0000000000010Z',
    '01HXAPND0000000000008X',
  ]);
  // Re-dispatch of an already-seen row is dropped (preserved row stays unique).
  es.dispatch('appended', meta('01HXAPND0000000000008X', 800));
  expect(sub.records.value).toHaveLength(3);
});
