import { test } from 'vitest';

import { collectResponsesStream } from './collect.ts';
import type { ResponsesStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const ev = (event: ResponsesStreamEvent): DumpStreamEvent => ({ frame: { type: 'event', event }, ts: 0 });

// Thin-wrapper coverage; reducer heavy lifting lives in
// `reassembleResponsesEvents` and is covered by `reassemble_test.ts`.

const baseResponse = {
  id: 'r1', object: 'response' as const, model: 'gpt', output: [],
  status: 'in_progress' as const, error: null, incomplete_details: null,
};

test('happy path: response.completed → truncated=false, error=null, result populated', async () => {
  const outcome = await collectResponsesStream([
    ev({ type: 'response.created', response: baseResponse }),
    ev({ type: 'response.completed', response: { ...baseResponse, status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } }),
  ]);
  assertEquals(outcome.truncated, false);
  assertEquals(outcome.error, null);
  assertEquals(outcome.result?.status, 'completed');
});

test('missing terminal → truncated=true, error=null', async () => {
  const outcome = await collectResponsesStream([
    ev({ type: 'response.created', response: baseResponse }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, null);
});

test('error event → error reflects the message, truncated=true', async () => {
  const outcome = await collectResponsesStream([
    ev({ type: 'response.created', response: baseResponse }),
    ev({ type: 'error', code: 'overloaded', message: 'upstream busy', sequence_number: 0 }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, 'upstream busy');
});
