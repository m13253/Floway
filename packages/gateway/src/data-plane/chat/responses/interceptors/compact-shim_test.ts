import { test } from 'vitest';

import { encodePayload, expandShimCompactionItems, withResponsesCompactShim } from './compact-shim.ts';
import type { ResponsesInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { LayeredStatefulResponsesStore, MemoryStatefulResponsesBacking } from '../items/store.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assertEquals, stubProviderCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
};

const makeInvocation = (
  payload: Partial<ResponsesPayload> = {},
  options: { action?: 'generate' | 'compact'; flagOn?: boolean } = {},
): ResponsesInvocation => ({
  payload: { model: 'test-model', input: [], ...payload } as ResponsesPayload,
  action: options.action ?? 'generate',
  candidate: stubProviderCandidate({
    targetApi: 'responses',
    binding: { enabledFlags: new Set(options.flagOn === false ? [] : ['responses-compact-shim']) },
  }),
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
  headers: new Headers(),
});

// Build a fake upstream `run()` that emits a single completed response whose
// output contains one assistant message with the given text. Used to model
// the inner summarization turn the shim drives.
const fakeUpstreamRun = (summaryText: string): () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const response: ResponsesResult = {
    id: 'resp_fake_upstream',
    object: 'response',
    model: 'test-upstream-model',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: summaryText }],
    }],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  return () => Promise.resolve(eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
      yield doneFrame();
    })(),
    testTelemetryModelIdentity,
  ));
};

// ── Inbound expansion (expandShimCompactionItems) ────────────────────────────

test('inbound: compaction item with a shim-encoded payload expands inline', () => {
  const userItem = { type: 'message' as const, role: 'user' as const, content: 'history one' };
  const encoded = encodePayload([userItem]);

  const expanded = expandShimCompactionItems({
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_1', encrypted_content: encoded } as unknown as never,
      { type: 'message', role: 'user', content: 'new turn' },
    ],
  });

  if (typeof expanded.input === 'string') throw new Error('expected array input');
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], userItem);
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'new turn' });
});

test('inbound: foreign compaction blob (non-base64url-JSON) round-trips untouched', () => {
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  // No items expanded — the foreign blob fails decode and the item passes
  // through as-is.
  assertEquals(expanded, original);
});

test('inbound: foreign compaction blob (valid base64url but wrong shape) round-trips untouched', () => {
  // base64url-encoded JSON of an object (not an array) — decode succeeds,
  // but the schema check rejects it.
  const wrongShape = encodePayload({ not: 'an array' });
  const original = {
    model: 'm',
    input: [
      { type: 'compaction', id: 'cmp_foreign', encrypted_content: wrongShape } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(original);
  assertEquals(expanded, original);
});

test('inbound: string input is returned unchanged', () => {
  const result = expandShimCompactionItems({ model: 'm', input: 'plain string' });
  assertEquals(result.input, 'plain string');
});

// ── Outbound summarization (withResponsesCompactShim) ────────────────────────

test('compact + flag on: pivots to generate, drives upstream summarization, returns compaction envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'long conversation history' }] },
    { action: 'compact' },
  );

  let seenPayload: ResponsesPayload | undefined;
  let seenAction: 'generate' | 'compact' | undefined;
  const result = await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    seenAction = inv.action;
    return fakeUpstreamRun('CONDENSED SUMMARY')();
  });

  if (result.type !== 'events') throw new Error(`expected events branch, got ${result.type}`);
  // Inner action seen by the upstream is 'generate'.
  assertEquals(seenAction, 'generate');
  // Outer ctx.action is re-tagged 'compact' so attempt.invoke picks the
  // value-branch result + snapshot=replace.
  assertEquals(inv.action, 'compact');
  // Payload pivoted: SUMMARIZATION_PROMPT injected, store:false, the
  // original history retained (compaction_trigger items would be stripped
  // but there are none here).
  if (!seenPayload) throw new Error('expected the upstream call to see the rewritten payload');
  assertEquals(typeof seenPayload.instructions, 'string');
  assertEquals((seenPayload.instructions as string).includes('CONTEXT CHECKPOINT COMPACTION'), true);
  assertEquals(seenPayload.store, false);

  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.object, 'response.compaction');
  const compactionItem = collected.output[0] as { type: string; encrypted_content: string };
  assertEquals(compactionItem.type, 'compaction');
});

test('compact + flag on: synthesized encrypted_content decodes to a user message containing the summary', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );
  const result = await withResponsesCompactShim(inv, stubCtx, fakeUpstreamRun('THE SUMMARY'));
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  const compactionItem = collected.output[0] as { type: string; encrypted_content: string };

  // The encrypted_content decodes to our base64url-JSON marker: one
  // user-role message carrying the summary as input_text.
  const decoded = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(compactionItem.encrypted_content.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0),
      ),
    ),
  );
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].type, 'message');
  assertEquals(decoded[0].role, 'user');
  assertEquals(decoded[0].content[0].type, 'input_text');
  assertEquals(decoded[0].content[0].text, 'THE SUMMARY');
});

test('compact + flag on: upstream `output_text` SDK alias is dropped from the synthesized envelope', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );

  // Some upstreams (and some OpenAPI implementations) emit the convenience
  // `output_text` alias alongside `output`. The synthesized
  // `response.compaction` envelope must not forward it — its value is the
  // upstream's summary plaintext, which a downstream SDK reading
  // `output_text` on a compaction envelope would surface in place of the
  // opaque-blob contract `encrypted_content` is supposed to carry.
  const runWithOutputText = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const response: ResponsesResult = {
      id: 'resp_fake_upstream',
      object: 'response',
      model: 'test-upstream-model',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'THE SUMMARY' }],
      }],
      output_text: 'THE SUMMARY',
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    return Promise.resolve(eventResult(
      (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        yield eventFrame({ type: 'response.completed', sequence_number: 0, response });
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ));
  };
  const result = await withResponsesCompactShim(inv, stubCtx, runWithOutputText);
  if (result.type !== 'events') throw new Error('expected events branch');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  assertEquals(collected.output_text, undefined);
});

test('compact + flag on: compaction_trigger items are stripped before the upstream call', async () => {
  const inv = makeInvocation(
    {
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' } as unknown as never,
      ],
    },
    { action: 'compact' },
  );

  let seenPayload: ResponsesPayload | undefined;
  await withResponsesCompactShim(inv, stubCtx, () => {
    seenPayload = inv.payload;
    return fakeUpstreamRun('s')();
  });
  if (!seenPayload) throw new Error('expected the upstream call to fire');
  const items = seenPayload.input as Array<{ type: string }>;
  assertEquals(items.every(i => i.type !== 'compaction_trigger'), true);
});

test('compact + flag off: passes through to run() unchanged', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'compact me' }] },
    { action: 'compact', flagOn: false },
  );

  let runCalled = false;
  await withResponsesCompactShim(inv, stubCtx, () => {
    runCalled = true;
    return fakeUpstreamRun('unused')();
  });
  // Flag off: shim early-returns without expansion or pivot. The inner
  // run() is called directly, action stays 'compact', payload unchanged.
  assertEquals(runCalled, true);
  assertEquals(inv.action, 'compact');
});

test('generate + flag on: runs inbound expansion but does not pivot', async () => {
  const userItem = { type: 'message' as const, role: 'user' as const, content: 'expanded' };
  const encoded = encodePayload([userItem]);
  const inv = makeInvocation(
    {
      input: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: encoded } as unknown as never,
        { type: 'message', role: 'user', content: 'follow-up' },
      ],
    },
    { action: 'generate' },
  );

  let runCalled = false;
  await withResponsesCompactShim(inv, stubCtx, () => {
    runCalled = true;
    return fakeUpstreamRun('unused')();
  });
  assertEquals(runCalled, true);
  // generate action stays as-is.
  assertEquals(inv.action, 'generate');
  // Inbound expansion ran: the compaction item was replaced by `userItem`.
  const items = inv.payload.input as Array<{ type: string; content?: unknown }>;
  assertEquals(items.length, 2);
  assertEquals(items[0], userItem);
});

test('compact + flag on: upstream api-error propagates', async () => {
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'history' }] },
    { action: 'compact' },
  );

  const errorResult: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = {
    type: 'api-error',
    source: 'upstream',
    status: 502,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode('{"error":"upstream blew up"}'),
  };
  const result = await withResponsesCompactShim(inv, stubCtx, () => Promise.resolve(errorResult));
  if (result.type !== 'api-error') throw new Error(`expected api-error, got ${result.type}`);
  assertEquals(result.status, 502);
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('round-trip: outbound synthesis then inbound expansion recovers the summary message', async () => {
  // Step 1: simulate compaction — returns the synthesized envelope with
  // shim-encoded `encrypted_content`.
  const inv = makeInvocation(
    { input: [{ type: 'message', role: 'user', content: 'long convo' }] },
    { action: 'compact' },
  );
  const result = await withResponsesCompactShim(inv, stubCtx, fakeUpstreamRun('SUMMARY TEXT'));
  if (result.type !== 'events') throw new Error('expected events');
  const collected = await collectResponsesProtocolEventsToResult(result.events);
  const compactionItem = collected.output[0] as { type: string; id?: string; encrypted_content: string };

  // Step 2: next turn echoes the compaction item back as an input item;
  // inbound expansion replaces it with the summary message.
  const nextTurn: ResponsesPayload = {
    model: 'test-model',
    input: [
      { type: 'compaction', id: compactionItem.id ?? 'cmp_rt', encrypted_content: compactionItem.encrypted_content } as unknown as never,
    ],
  };
  const expanded = expandShimCompactionItems(nextTurn);
  const items = expanded.input as Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
  assertEquals(items.length, 1);
  assertEquals(items[0].type, 'message');
  assertEquals(items[0].role, 'user');
  assertEquals(items[0].content[0].text, 'SUMMARY TEXT');
});
