import { test } from 'vitest';

import { withInlineImagesCompressed } from './compress-images.ts';
import { initImageProcessor } from '../../../../../image/index.ts';
import type { ImageProcessor } from '../../../../../image/types.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

// Records the bytes handed to the processor and returns a fixed [1,2,3] WebP
// payload, which base64-encodes to "AQID".
const spyProcessor = (): { processor: ImageProcessor; inputs: Uint8Array[] } => {
  const inputs: Uint8Array[] = [];
  const processor: ImageProcessor = {
    compressToWebp(input) {
      inputs.push(input);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  };
  return { processor, inputs };
};

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('compresses a top-level image block to WebP', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const block = (ctx.payload.messages[0].content as Array<{ type: string; source?: { media_type: string; data: string } }>)[1];
  assertEquals(block.source?.media_type, 'image/webp');
  assertEquals(block.source?.data, 'AQID');
  // "AAAA" decodes to three zero bytes.
  assertEquals([...inputs[0]], [0, 0, 0]);
});

test('compresses an image nested inside tool_result content', async () => {
  const { processor } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_image',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
          },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const toolResult = (ctx.payload.messages[0].content as Array<{ content: Array<{ source?: { media_type: string; data: string } }> }>)[0];
  assertEquals(toolResult.content[0].source?.media_type, 'image/webp');
  assertEquals(toolResult.content[0].source?.data, 'AQID');
});

test('leaves image-free payloads untouched and does not invoke the processor', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);

  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(inputs.length, 0);
});
