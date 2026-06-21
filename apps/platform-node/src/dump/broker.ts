import type { DumpBroker } from '@floway-dev/gateway';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// In-process per-key fan-out backed by EventTarget. The Node deployment
// target only ever runs one worker process per gateway instance, so a Map
// of plain emitters is enough — no IPC, no cross-process broadcast.
//
// Entries live until `notifyDisabled` drops them; a re-enable allocates a
// fresh EventTarget on demand. The total number of distinct keys held at
// any moment is bounded by the active subset of `api_keys` rows.
export class InProcessDumpBroker implements DumpBroker {
  private readonly targets = new Map<string, EventTarget>();

  private targetFor(keyId: string): EventTarget {
    let target = this.targets.get(keyId);
    if (!target) {
      target = new EventTarget();
      this.targets.set(keyId, target);
    }
    return target;
  }

  async publish(keyId: string, meta: DumpMetadata): Promise<void> {
    this.targetFor(keyId).dispatchEvent(new CustomEvent('appended', { detail: meta }));
  }

  async notifyDisabled(keyId: string): Promise<void> {
    const target = this.targets.get(keyId);
    if (!target) return;
    target.dispatchEvent(new Event('disabled'));
    // Drop the target entry so the map size stays bounded across repeated
    // enable/disable cycles; a future re-enable on the same keyId allocates
    // a fresh EventTarget on demand.
    this.targets.delete(keyId);
  }

  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata> {
    return iterateFromTarget(this.targetFor(keyId), signal);
  }
}

// Listener registration happens eagerly inside `iterateFromTarget` so that a
// caller who awaits subscribe and then publishes a meta before draining the
// iterator still receives the buffered frame. A generator that registers in
// its body would miss the publish because the body doesn't run until the
// first `.next()` call.
const iterateFromTarget = (target: EventTarget, signal: AbortSignal): AsyncIterable<DumpMetadata> => {
  const queue: DumpMetadata[] = [];
  let resolveNext: ((value: IteratorResult<DumpMetadata>) => void) | null = null;
  let closed = false;

  const deliver = (value: IteratorResult<DumpMetadata>): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(value);
    } else if (!value.done) {
      queue.push(value.value);
    }
  };

  const onAppended = (event: Event): void => {
    if (closed) return;
    const detail = (event as CustomEvent<DumpMetadata>).detail;
    deliver({ value: detail, done: false });
  };
  const onDisabled = (): void => {
    if (closed) return;
    closed = true;
    detach();
    deliver({ value: undefined as never, done: true });
  };
  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    detach();
    deliver({ value: undefined as never, done: true });
  };
  const detach = (): void => {
    target.removeEventListener('appended', onAppended);
    target.removeEventListener('disabled', onDisabled);
    signal.removeEventListener('abort', onAbort);
  };

  target.addEventListener('appended', onAppended);
  target.addEventListener('disabled', onDisabled);
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
      async next(): Promise<IteratorResult<DumpMetadata>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) return { value: undefined as never, done: true };
        return await new Promise<IteratorResult<DumpMetadata>>(resolve => { resolveNext = resolve; });
      },
      async return(): Promise<IteratorResult<DumpMetadata>> {
        if (!closed) {
          closed = true;
          detach();
        }
        return { value: undefined as never, done: true };
      },
    }),
  };
};
