import { test } from 'vitest';

import { parseMessagesStream } from './stream.ts';
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

test('parseMessagesStream parses Messages SSE frames into protocol events', async () => {
  const frames = await collect(parseMessagesStream(sseBody(
    sseFrame('', 'ping'),
    sseFrame(
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      'message_start',
    ),
    sseFrame('[DONE]'),
  )));

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'done'],
  );
  assertEquals(frames[0], {
    type: 'event',
    event: {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  });
});

test('parseMessagesStream rejects malformed Messages SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parseMessagesStream(sseBody(
        sseFrame('not json', 'message_delta'),
      )));
    },
    Error,
    'Malformed upstream Messages SSE JSON for event "message_delta": not json',
  );
});
