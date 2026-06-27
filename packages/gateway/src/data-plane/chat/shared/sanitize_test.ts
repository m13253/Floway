import { test } from 'vitest';

import {
  createSanitizeTraceCtx,
  sanitizeForChatCompletionsUpstream,
  sanitizeForMessagesUpstream,
  sanitizeForResponsesUpstream,
  type SanitizeTraceCtx,
} from './sanitize.ts';
import { assertEquals } from '@floway-dev/test-utils';

type TraceLine = { field: string; targetProtocol: string };

const makeTrace = (): { ctx: SanitizeTraceCtx; lines: TraceLine[] } => {
  const lines: TraceLine[] = [];
  return {
    ctx: { emit: line => lines.push(line) },
    lines,
  };
};

test('sanitizeForMessagesUpstream strips verbosity and emits one trace line', () => {
  const body: Record<string, unknown> = { verbosity: 'low', model: 'x' };
  const { ctx, lines } = makeTrace();
  sanitizeForMessagesUpstream(body, ctx);
  assertEquals(body, { model: 'x' });
  assertEquals(lines.length, 1);
  assertEquals(lines[0].field, 'verbosity');
  assertEquals(lines[0].targetProtocol, 'messages');
});

test('sanitizeForChatCompletionsUpstream strips Floway extensions and leaves native fields', () => {
  const body: Record<string, unknown> = {
    thinking_budget: 4096,
    reasoning_summary: 'concise',
    reasoning_effort: 'high',
    model: 'x',
  };
  const { ctx, lines } = makeTrace();
  sanitizeForChatCompletionsUpstream(body, ctx);
  assertEquals(body, { reasoning_effort: 'high', model: 'x' });
  assertEquals(lines.length, 2);
  assertEquals(lines.every(l => l.targetProtocol === 'chat-completions'), true);
  const droppedFields = lines.map(l => l.field).sort();
  assertEquals(droppedFields, ['reasoning_summary', 'thinking_budget']);
});

test('sanitizeForResponsesUpstream strips extensions when fed the default per-request trace', () => {
  const body: Record<string, unknown> = { adaptive_thinking: true, thinking_budget: 4096 };
  sanitizeForResponsesUpstream(body, createSanitizeTraceCtx());
  assertEquals(body, {});
});

test('sanitizer is idempotent — a second run emits no additional traces', () => {
  const body: Record<string, unknown> = { verbosity: 'low', model: 'x' };
  const { ctx, lines } = makeTrace();
  sanitizeForMessagesUpstream(body, ctx);
  assertEquals(lines.length, 1);
  sanitizeForMessagesUpstream(body, ctx);
  assertEquals(lines.length, 1);
});
