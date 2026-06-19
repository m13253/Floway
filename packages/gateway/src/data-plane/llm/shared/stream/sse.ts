import type { SSEStreamingApi } from 'hono/streaming';

import type { SseFrame, SseWritableFrame } from '@floway-dev/protocols/common';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

// Upstream SSE idle window before we treat the connection as stalled and abort
// it. Anthropic's normal cadence — including its own `event: ping` heartbeats
// — runs at ≤30s; 60s gives a 2× headroom for slow large-model deliberation
// while staying well under the Cloudflare Workers HTTP timeout (~100s) so a
// genuinely-stuck upstream surfaces as a clean error before the runtime kills
// the request. sub2api defaults this off (operator opt-in 30-300s); we
// default it on so a stuck upstream cannot pin a request indefinitely.
export const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

export class UpstreamIdleTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Upstream stream idle for ${timeoutMs}ms`);
    this.name = 'UpstreamIdleTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

interface IdleTimeoutOptions {
  ms: number;
  onTimeout?: () => void;
}

// Wraps an async iterable so every `next()` races a setTimeout. When the timer
// wins, `onTimeout` runs (typically aborting the upstream fetch) and the
// wrapped iterable throws an `UpstreamIdleTimeoutError`. Each successful
// frame resets the window — Anthropic's own `event: ping` keepalives count,
// since they survive parse-sse as real frames.
export const withIdleTimeout = <T>(events: AsyncIterable<T>, options: IdleTimeoutOptions): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    const iterator = events[Symbol.asyncIterator]();
    return {
      async next(): Promise<IteratorResult<T>> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutMarker = Symbol('idle-timeout');
        const timeoutPromise = new Promise<typeof timeoutMarker>(resolve => {
          timeoutId = setTimeout(() => {
            timeoutId = undefined;
            options.onTimeout?.();
            resolve(timeoutMarker);
          }, options.ms);
        });
        try {
          const winner = await Promise.race([iterator.next(), timeoutPromise]);
          if (winner === timeoutMarker) {
            // Best-effort cleanup of the upstream iterator after we've
            // committed to the timeout outcome. Awaiting return() here
            // would race with the upstream's still-pending read; firing it
            // detached lets the abort signal propagate while we surface
            // the failure to our consumer.
            iterator.return?.().catch(() => {});
            throw new UpstreamIdleTimeoutError(options.ms);
          }
          return winner;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      },
      return(value) {
        return iterator.return?.(value) ?? Promise.resolve({ done: true, value });
      },
    };
  },
});

interface SseKeepAliveOptions {
  intervalMs?: number;
  frame: SseWritableFrame;
}

interface SseStreamOptions {
  keepAlive?: SseKeepAliveOptions;
  downstreamAbortController?: AbortController;
}

type ResolvedSseKeepAliveOptions = Required<SseKeepAliveOptions>;

type NextFrameResult = { type: 'frame'; result: IteratorResult<SseFrame> } | { type: 'next-error'; error: unknown } | { type: 'keep-alive' } | { type: 'abort' };

export type StreamCompletion = 'eof' | 'error' | 'cancel';

const resolveKeepAliveOptions = (keepAlive: SseKeepAliveOptions | undefined): ResolvedSseKeepAliveOptions | undefined => {
  if (!keepAlive) return undefined;

  const intervalMs = keepAlive.intervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('SSE keepalive interval must be a positive number');
  }

  return { intervalMs, frame: keepAlive.frame };
};

const serializeSSECommentFrame = (comment: string): string =>
  `${comment
    .split(/\r\n|\r|\n/)
    .map(line => `: ${line}`)
    .join('\n')}\n\n`;

const writeSSEFrame = async (stream: SSEStreamingApi, frame: SseWritableFrame): Promise<void> => {
  if (stream.aborted || stream.closed) return;

  if (frame.type === 'sse-comment') {
    await stream.write(serializeSSECommentFrame(frame.comment));
    return;
  }

  await stream.writeSSE({
    event: frame.event,
    data: frame.data,
  });
};

const streamAbortPromise = (stream: SSEStreamingApi): Promise<void> => {
  if (stream.aborted || stream.closed) return Promise.resolve();

  return new Promise(resolve => {
    stream.onAbort(resolve);
  });
};

const pendingFrameResult = (pendingNext: Promise<IteratorResult<SseFrame>>): Promise<NextFrameResult> =>
  pendingNext.then(
    (result): NextFrameResult => ({ type: 'frame', result }),
    (error): NextFrameResult => ({ type: 'next-error', error }),
  );

const nextFrameOrKeepAlive = async (
  pendingFrame: Promise<NextFrameResult>,
  pendingAbort: Promise<NextFrameResult>,
  keepAlive: ResolvedSseKeepAliveOptions | undefined,
): Promise<NextFrameResult> => {
  if (!keepAlive) return await Promise.race([pendingFrame, pendingAbort]);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const pendingKeepAlive = new Promise<{ type: 'keep-alive' }>(resolve => {
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      resolve({ type: 'keep-alive' });
    }, keepAlive.intervalMs);
  });

  try {
    return await Promise.race([pendingFrame, pendingAbort, pendingKeepAlive]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const drainSSEFrames = async (
  stream: SSEStreamingApi,
  events: AsyncIterable<SseFrame>,
  keepAlive: ResolvedSseKeepAliveOptions | undefined,
  downstreamAbortController: AbortController | undefined,
): Promise<StreamCompletion> => {
  const iterator = events[Symbol.asyncIterator]();
  const abortDownstream = () => {
    if (!downstreamAbortController?.signal.aborted) {
      downstreamAbortController?.abort();
    }
  };
  const abortResult = streamAbortPromise(stream).then((): NextFrameResult => {
    abortDownstream();
    return { type: 'abort' };
  });
  let pendingNext = pendingFrameResult(iterator.next());
  let completed = false;
  let stoppedByDownstream = false;

  const stopForDownstream = () => {
    stoppedByDownstream = true;
    abortDownstream();
  };

  try {
    while (true) {
      if (stream.aborted || stream.closed) {
        stopForDownstream();
        return 'cancel';
      }

      const next = await nextFrameOrKeepAlive(pendingNext, abortResult, keepAlive);

      if (next.type === 'abort') {
        stopForDownstream();
        return 'cancel';
      }
      if (next.type === 'keep-alive') {
        if (!keepAlive) continue;
        await writeSSEFrame(stream, keepAlive.frame);
        continue;
      }
      if (next.type === 'next-error') {
        if (stream.aborted || stream.closed) {
          stopForDownstream();
          return 'cancel';
        }
        throw next.error;
      }

      if (next.result.done) {
        completed = true;
        return 'eof';
      }

      await writeSSEFrame(stream, next.result.value);
      pendingNext = pendingFrameResult(iterator.next());
    }
  } finally {
    if (!completed) {
      const stopped = iterator.return?.();
      // Downstream already cancelled; cleanup errors from the upstream
      // iterator have nowhere to surface to. Awaiting the rejection would
      // leak it as an unhandled rejection.
      if (stoppedByDownstream) stopped?.catch(() => {});
      else await stopped;
    }
  }
};

export const writeSSEFrames = async (stream: SSEStreamingApi, events: AsyncIterable<SseFrame>, options: SseStreamOptions = {}): Promise<StreamCompletion> => {
  const keepAlive = resolveKeepAliveOptions(options.keepAlive);
  return await drainSSEFrames(stream, events, keepAlive, options.downstreamAbortController);
};
