import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Resolver for the next-message wait. publish() calls resolve() to wake the
// iterator; abort() also calls it to end the loop.
type Waker = () => void;

class KeyChannel {
  // Pending messages queued for each subscriber. Each subscriber sees the same
  // sequence — we publish into every queue at the same time so a subscriber
  // that started before publish() always observes the message, and one that
  // subscribed after never sees it (live pub-sub semantics; recovery is via
  // DumpStore.list).
  readonly queues = new Set<DumpMetadata[]>();
  readonly wakers = new Map<DumpMetadata[], Waker>();
}

export class NodeDumpBroker implements DumpBroker {
  private readonly channels = new Map<string, KeyChannel>();

  publish(keyId: string, meta: DumpMetadata): void {
    const channel = this.channels.get(keyId);
    if (!channel) return;
    for (const queue of channel.queues) {
      queue.push(meta);
      const waker = channel.wakers.get(queue);
      if (waker) {
        channel.wakers.delete(queue);
        waker();
      }
    }
  }

  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata> {
    let channel = this.channels.get(keyId);
    if (!channel) {
      channel = new KeyChannel();
      this.channels.set(keyId, channel);
    }
    const ownChannel = channel;
    const queue: DumpMetadata[] = [];
    ownChannel.queues.add(queue);

    const cleanup = (): void => {
      ownChannel.queues.delete(queue);
      ownChannel.wakers.delete(queue);
      if (ownChannel.queues.size === 0) this.channels.delete(keyId);
    };

    const wake = (): void => {
      const waker = ownChannel.wakers.get(queue);
      if (waker) {
        ownChannel.wakers.delete(queue);
        waker();
      }
    };
    signal.addEventListener('abort', wake, { once: true });

    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            await new Promise<void>(resolve => ownChannel.wakers.set(queue, resolve));
          }
        } finally {
          signal.removeEventListener('abort', wake);
          cleanup();
        }
      },
    };
  }
}
