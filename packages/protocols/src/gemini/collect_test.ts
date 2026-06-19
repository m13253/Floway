import { test } from 'vitest';

import { collectGeminiStream } from './collect.ts';
import type { GeminiResult } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const dumpEvent = (chunk: GeminiResult): DumpStreamEvent => ({
  event: null,
  data: JSON.stringify(chunk),
  ts: 0,
});

test('collectGeminiStream concatenates candidate text and copies usageMetadata from the last chunk', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }],
      modelVersion: 'gemini-2.5-pro',
      responseId: 'resp_1',
    }),
    dumpEvent({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ', world' }] } }],
    }),
    dumpEvent({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: '!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
    }),
  ];

  const result = collectGeminiStream(events);

  assertEquals(result.modelVersion, 'gemini-2.5-pro');
  assertEquals(result.responseId, 'resp_1');
  assertEquals(result.usageMetadata, { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 });
  assertEquals(result.candidates?.length, 1);
  const candidate = result.candidates![0];
  assertEquals(candidate.finishReason, 'STOP');
  assertEquals(candidate.content.parts, [{ text: 'Hello, world!' }]);
});
