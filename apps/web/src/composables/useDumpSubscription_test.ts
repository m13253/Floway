import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';

import { useDumpSubscription } from './useDumpSubscription.ts';
import { useAuthStore } from '../stores/auth.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal EventSource shim mirroring the surface the composable touches:
// `addEventListener('snapshot' | 'appended' | 'error')`, `readyState`, `close`,
// `url`. We expose `emit()` so each test drives the stream by hand.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static lastUrl: string | null = null;

  readyState = 0;
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.lastUrl = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data, type });
  }

  emitClose() {
    this.readyState = 2;
    this.emit('error', '');
  }

  emitTransientBlip() {
    this.readyState = 0;
    this.emit('error', '');
  }
}

const meta = (id: string, overrides: Partial<DumpMetadata> = {}): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 0,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  upstream: null,
  model: 'gpt-4o',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  error: null,
  ...overrides,
});

const newest = (n: number) => meta(`r-${n.toString().padStart(3, '0')}`);

const setup = () => {
  FakeEventSource.instances = [];
  FakeEventSource.lastUrl = null;
  setActivePinia(createPinia());
  useAuthStore().setAuth({
    token: 'tok-abc',
    user: {
      id: 1,
      username: 'op',
      isAdmin: true,
      canViewGlobalTelemetry: true,
      upstreamIds: null,
    },
  });
  const scope = effectScope();
  return { scope };
};

beforeEach(() => setup());

describe('useDumpSubscription', () => {
  it('is a no-op when keyId is empty', () => {
    const { scope } = setup();
    const keyId = ref('');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    expect(FakeEventSource.instances.length).toBe(0);
    expect(sub.records.value).toEqual([]);
    expect(sub.loading.value).toBe(false);
    scope.stop();
  });

  it('opens an EventSource and rebuilds records from the snapshot', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.lastUrl).toContain('/api/dump/keys/key1/stream?session=tok-abc');
    expect(sub.loading.value).toBe(true);

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(5), newest(4), newest(3)],
    }));

    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-004', 'r-003']);
    expect(sub.loading.value).toBe(false);
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('snapshot rebuild preserves paged-in older records on reconnect', async () => {
    const { scope } = setup();
    const keyId = ref('key1');
    let mockResponse: { ok: boolean; status: number; json: () => Promise<unknown> } = {
      ok: true,
      status: 200,
      json: async () => ({ records: [newest(2), newest(1)] }),
    };
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
      fetcher: async () => mockResponse as unknown as Response,
    }))!;

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(5), newest(4), newest(3)],
    }));
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-004', 'r-003', 'r-002', 'r-001']);

    // Reconnect: server sends a fresh snapshot (with a new record on top).
    // The paged-in r-002/r-001 must survive.
    mockResponse = { ok: true, status: 200, json: async () => ({ records: [] }) };
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(6), newest(5), newest(4), newest(3)],
    }));
    expect(sub.records.value.map(r => r.id)).toEqual(['r-006', 'r-005', 'r-004', 'r-003', 'r-002', 'r-001']);
    scope.stop();
  });

  it('dedups by id on appended events', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(1)] }));
    FakeEventSource.instances[0]!.emit('appended', JSON.stringify(newest(2)));
    FakeEventSource.instances[0]!.emit('appended', JSON.stringify(newest(2)));
    expect(sub.records.value.map(r => r.id)).toEqual(['r-002', 'r-001']);
    scope.stop();
  });

  it('surfaces server-sent error frames to error.value', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    FakeEventSource.instances[0]!.emit('error', JSON.stringify({ message: 'broker exploded' }));
    expect(sub.error.value).toBe('broker exploded');
    scope.stop();
  });

  it('falls back to "Stream disconnected" when transport closes with no payload', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    FakeEventSource.instances[0]!.emitClose();
    expect(sub.error.value).toBe('Stream disconnected');
    scope.stop();
  });

  it('ignores transient transport blips during auto-reconnect', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    FakeEventSource.instances[0]!.emitTransientBlip();
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('successful (re)snapshot clears a stale error banner', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
    }))!;
    FakeEventSource.instances[0]!.emit('error', JSON.stringify({ message: 'transient' }));
    expect(sub.error.value).toBe('transient');
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(1)] }));
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('loadOlder appends and dedups', async () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const olderPages = [
      { records: [newest(2), newest(1)] },
      { records: [newest(1)] }, // already-seen ids -> noop
    ];
    let call = 0;
    const sub = scope.run(() => useDumpSubscription(keyId, {
      eventSourceFactory: url => new FakeEventSource(url) as unknown as EventSource,
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => olderPages[call++],
      } as unknown as Response),
    }))!;

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(5), newest(3)] }));
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-003', 'r-002', 'r-001']);
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-003', 'r-002', 'r-001']);
    scope.stop();
  });
});
