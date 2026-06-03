import { test } from 'vitest';

import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { createHttpStatefulResponsesStore } from '../../../../llm/sources/responses/stateful-store.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ImageProcessor, type ExecuteResult, eventResult } from '@floway-dev/provider';
import { initImageProcessor } from '@floway-dev/provider';
import { withInlineImagesCompressed } from '@floway-dev/provider-copilot/interceptors/chat-completions/compress-images';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  apiKeyUpstreamIds: null,
  runtimeLocation: 'test',
  clientStream: false,
  statefulResponsesStore: createHttpStatefulResponsesStore(null, undefined),
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const imageUrl = (payload: ChatCompletionsPayload): string => {
  const part = (payload.messages[0].content as Array<{ type: string; image_url?: { url: string } }>).find(p => p.type === 'image_url');
  return part?.image_url?.url ?? '';
};

test('rewrites a base64 image_url data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'data:image/webp;base64,AQID');
});

test('leaves remote https image references untouched', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'https://example.com/cat.png');
});
