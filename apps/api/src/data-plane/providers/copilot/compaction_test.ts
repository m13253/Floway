import { expect, test } from 'vitest';

import { compactionResponse } from './compaction.ts';
import type { ResponsesInputItem, ResponsesResult } from '@floway-dev/protocols/responses';

const generatedResult = (output: unknown[]): ResponsesResult =>
  ({
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.2-codex',
    output: output as ResponsesResult['output'],
    status: 'completed',
    incomplete_details: null,
    error: null,
    usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
  }) as ResponsesResult;

const compaction = { type: 'compaction', id: 'cmp_1', encrypted_content: 'BLOB' };

const shape = (result: ResponsesResult): string[] =>
  result.output.map(item => (item.type === 'compaction' ? 'compaction' : `${item.type}:${(item as { role?: string }).role}`));

test('keeps retained user/developer/system messages and appends the compaction item, dropping assistant turns', () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'message', role: 'system', content: 'be nice' },
  ];
  // The trigger turn may also emit a stray assistant message; only the lone
  // compaction item survives, regardless of the generated assistant output.
  const result = compactionResponse(input, generatedResult([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stray' }] }, compaction]));

  expect(result.object).toBe('response.compaction');
  expect(shape(result)).toEqual(['message:user', 'message:system', 'compaction']);
  expect(result.output.at(-1)).toEqual(compaction);
});

test('throws when the trigger turn did not return exactly one compaction item', () => {
  expect(() => compactionResponse([], generatedResult([]))).toThrow(/exactly one compaction/);
  expect(() => compactionResponse([], generatedResult([compaction, { type: 'compaction', id: 'cmp_2', encrypted_content: 'X' }]))).toThrow(/exactly one compaction/);
});

test('truncates retained messages newest-first to the 64k token budget', () => {
  // codex token heuristic is ceil(utf8_bytes / 4); 4 ASCII bytes ≈ 1 token.
  const oldest: ResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(64_001 * 4) }] };
  const newest: ResponsesInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent' }] };
  const result = compactionResponse([oldest, newest], generatedResult([compaction]));

  // The oldest message alone exceeds the budget once the newest is kept, so it
  // drops entirely; only the recent message and the compaction blob remain.
  expect(result.output).toHaveLength(2);
  expect((result.output[0] as { role?: string }).role).toBe('user');
  expect((result.output[0] as { content?: unknown }).content).toEqual([{ type: 'input_text', text: 'recent' }]);
  expect(result.output[1]).toEqual(compaction);
});

test('retains a message whose content is a plain string', () => {
  const result = compactionResponse([{ type: 'message', role: 'user', content: 'hi there' }], generatedResult([compaction]));
  expect(shape(result)).toEqual(['message:user', 'compaction']);
});
