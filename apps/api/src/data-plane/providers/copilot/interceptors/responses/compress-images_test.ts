import { test } from 'vitest';

import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { createHttpStatefulResponsesStore } from '../../../../llm/sources/responses/stateful-store.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ImageProcessor, type ExecuteResult, eventResult } from '@floway-dev/provider';
import { initImageProcessor } from '@floway-dev/provider';
import { withInlineImagesCompressed } from '@floway-dev/provider-copilot/interceptors/responses/compress-images';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  apiKeyUpstreamIds: null,
  runtimeLocation: 'test',
  clientStream: false,
  statefulResponsesStore: createHttpStatefulResponsesStore(null, undefined),
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const firstImageUrl = (payload: ResponsesPayload): string => {
  const input = payload.input as Array<{ type: string; content?: Array<{ type: string; image_url?: string }> }>;
  const message = input.find(item => item.type === 'message');
  const image = message?.content?.find(part => part.type === 'input_image');
  return image?.image_url ?? '';
};

test('rewrites a base64 input_image data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(firstImageUrl(ctx.payload), 'data:image/webp;base64,AQID');
});

test('leaves remote https image references untouched', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'auto' }],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(firstImageUrl(ctx.payload), 'https://example.com/cat.png');
});

test('compresses base64 images inside function_call_output tool outputs', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'screenshot' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const output = (ctx.payload.input as Array<{ type: string; output?: Array<{ type: string; image_url?: string }> }>)[0].output;
  assertEquals(output?.find(part => part.type === 'input_image')?.image_url, 'data:image/webp;base64,AQID');
});
