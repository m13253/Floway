import { test } from 'vitest';

import { collectGeminiStream } from './collect.ts';
import type { GeminiResult, GeminiStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const ev = (chunk: GeminiResult): DumpStreamEvent => ({
  frame: { type: 'event', event: chunk as unknown as GeminiStreamEvent },
  ts: 0,
});

// Thin-wrapper coverage. Gemini's reducer lives inline in `to-result.ts`
// and is covered by `to-result_test.ts`.

test('happy path: finishReason present → truncated=false, error=null, candidate text concatenated', async () => {
  const outcome = await collectGeminiStream([
    ev({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] }),
    ev({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' there' }] }, finishReason: 'STOP' }] }),
  ]);
  assertEquals(outcome.truncated, false);
  assertEquals(outcome.error, null);
  assertEquals(outcome.result?.candidates?.[0]?.content?.parts, [{ text: 'hi there' }]);
});

test('no finishReason → truncated=true, error=null, best-effort partial', async () => {
  const outcome = await collectGeminiStream([
    ev({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, null);
});
