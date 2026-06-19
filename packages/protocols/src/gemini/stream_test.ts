import { test } from 'vitest';

import { parseGeminiStream } from './stream.ts';
import { assertEquals } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const streamFromBytes = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
});

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

test('parseGeminiStream yields each data frame split on \\n\\n boundaries', async () => {
  const body = streamFromBytes(encode(
    'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"index":0}]}\n\n'
    + 'data: {"candidates":[{"content":{"parts":[{"text":" there"}]},"index":0}]}\n\n',
  ));

  const chunks = await collect(parseGeminiStream(body));

  assertEquals(chunks, [
    { chunk: '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"index":0}]}' },
    { chunk: '{"candidates":[{"content":{"parts":[{"text":" there"}]},"index":0}]}' },
  ]);
});

test('parseGeminiStream reassembles frames split across reader pulls', async () => {
  const body = streamFromBytes(
    encode('data: {"candi'),
    encode('dates":[{"content":{"parts":[{"text":"hi"}]},"index":0}]}\n'),
    encode('\ndata: {"candidates":[{"content"'),
    encode(':{"parts":[{"text":"!"}]},"index":0}]}\n\n'),
  );

  const chunks = await collect(parseGeminiStream(body));

  assertEquals(chunks, [
    { chunk: '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"index":0}]}' },
    { chunk: '{"candidates":[{"content":{"parts":[{"text":"!"}]},"index":0}]}' },
  ]);
});

test('parseGeminiStream stops yielding after signal abort', async () => {
  const controller = new AbortController();
  // A pull-based stream that never resolves more chunks; the parser must exit
  // when the abort fires, not hang waiting for the next read.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encode('data: {"candidates":[]}\n\n'));
    },
    pull() {
      return new Promise(() => {});
    },
  });

  const iter = parseGeminiStream(body, { signal: controller.signal });
  const first = await iter.next();
  assertEquals(first, { value: { chunk: '{"candidates":[]}' }, done: false });

  const next = iter.next();
  controller.abort();
  const result = await next;
  assertEquals(result.done, true);
});
