import { test } from 'vitest';

import { collectGeminiStream } from './collect.ts';
import type { GeminiErrorResponse, GeminiResult } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const dumpEvent = (chunk: GeminiResult | GeminiErrorResponse): DumpStreamEvent => ({
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

  const outcome = collectGeminiStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, false);
  const result = outcome.result!;
  assertEquals(result.modelVersion, 'gemini-2.5-pro');
  assertEquals(result.responseId, 'resp_1');
  assertEquals(result.usageMetadata, { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 });
  assertEquals(result.candidates?.length, 1);
  const candidate = result.candidates![0];
  assertEquals(candidate.finishReason, 'STOP');
  assertEquals(candidate.content.parts, [{ text: 'Hello, world!' }]);
});

test('collectGeminiStream marks truncated when no candidate carries a finishReason', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'half-baked' }] } }],
    }),
  ];

  const outcome = collectGeminiStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.candidates![0].content.parts, [{ text: 'half-baked' }]);
});

test('collectGeminiStream surfaces a Gemini error envelope and keeps any partial candidates', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }],
    }),
    dumpEvent({ error: { code: 500, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } }),
  ];

  const outcome = collectGeminiStream(events);

  assertEquals(outcome.error, 'quota exhausted');
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.candidates![0].content.parts, [{ text: 'partial' }]);
});

test('collectGeminiStream folds multiple candidates independently and sorts by index', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      candidates: [
        { index: 1, content: { role: 'model', parts: [{ text: 'two' }] }, finishReason: 'STOP' },
        { index: 0, content: { role: 'model', parts: [{ text: 'one' }] }, finishReason: 'STOP' },
      ],
    }),
  ];

  const outcome = collectGeminiStream(events);

  assertEquals(outcome.truncated, false);
  const candidates = outcome.result!.candidates!;
  assertEquals(candidates.length, 2);
  assertEquals(candidates[0].index, 0);
  assertEquals(candidates[0].content.parts, [{ text: 'one' }]);
  assertEquals(candidates[1].index, 1);
  assertEquals(candidates[1].content.parts, [{ text: 'two' }]);
});

test('collectGeminiStream concatenates text parts split across chunk boundaries', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'pre' }] },
      }],
    }),
    dumpEvent({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'fix' }] },
        finishReason: 'STOP',
      }],
    }),
  ];

  const outcome = collectGeminiStream(events);

  assertEquals(outcome.truncated, false);
  // The 'pre' and 'fix' fragments at index 0 collapse into a single 'prefix' part.
  assertEquals(outcome.result!.candidates![0].content.parts, [{ text: 'prefix' }]);
});

test('collectGeminiStream returns null result when no chunks were emitted', () => {
  const outcome = collectGeminiStream([]);

  assertEquals(outcome.result, null);
  assertEquals(outcome.truncated, true);
  if (!outcome.error?.includes('no chunks')) {
    throw new Error(`expected error to mention no chunks, got ${outcome.error}`);
  }
});
