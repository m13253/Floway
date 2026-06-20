import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// In-process per-key fan-out backed by EventTarget. The Node deployment
// target only ever runs one worker process per gateway instance, so a Map
// of plain emitters is enough — no IPC, no cross-process broadcast.
//
// EventTargets stick around per keyId forever once created; that's fine for
// the bounded number of distinct keys in any single floway install (each
// row in api_keys is a separate target, never more than a few thousand).
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
    if (target) target.dispatchEvent(new Event('disabled'));
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
    deliver({ value: undefined as never, done: true });
  };
  const onAbort = (): void => onDisabled();

  target.addEventListener('appended', onAppended);
  target.addEventListener('disabled', onDisabled);
  signal.addEventListener('abort', onAbort, { once: true });

  const detach = (): void => {
    target.removeEventListener('appended', onAppended);
    target.removeEventListener('disabled', onDisabled);
    signal.removeEventListener('abort', onAbort);
  };

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
      async next(): Promise<IteratorResult<DumpMetadata>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) { detach(); return { value: undefined as never, done: true }; }
        const result = await new Promise<IteratorResult<DumpMetadata>>(resolve => { resolveNext = resolve; });
        if (result.done) detach();
        return result;
      },
      async return(): Promise<IteratorResult<DumpMetadata>> {
        closed = true;
        detach();
        return { value: undefined as never, done: true };
      },
    }),
  };
};
