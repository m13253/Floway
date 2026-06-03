import { test } from 'vitest';

import { parseChatCompletionsStream } from './stream.ts';
import { type SseFrame } from '../common/sse.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const sseLine = (frame: SseFrame): string => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`;
const sseBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> => new Response(frames.map(sseLine).join('')).body!;
const sseFrame = (data: string, event?: string): SseFrame => ({ type: 'sse', event, data });

test('parseChatCompletionsStream parses Chat SSE chunks and done sentinel', async () => {
  const frames = await collect(parseChatCompletionsStream(sseBody(
    sseFrame(
      JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      }),
    ),
    sseFrame('[DONE]'),
  )));

  assertEquals(frames, [
    {
      type: 'event',
      event: {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      },
    },
    { type: 'done' },
  ]);
});

test('parseChatCompletionsStream rejects malformed Chat SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parseChatCompletionsStream(sseBody(
        sseFrame('not json'),
      )));
    },
    Error,
    'Malformed upstream Chat Completions SSE JSON: not json',
  );
});

test('parseChatCompletionsStream rejects upstream Chat SSE error payloads', async () => {
  await assertRejects(
    async () => {
      await collect(parseChatCompletionsStream(sseBody(
        sseFrame(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'upstream chat failed',
            },
          }),
        ),
      )));
    },
    Error,
    'Upstream Chat Completions SSE error: server_error: upstream chat failed',
  );
});
