import { test } from 'vitest';

import { isStoredResponsesItemId, parseStoredResponsesItemId } from './format.ts';
import { storeResponsesOutputItems } from './output.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { ResponsesItemsRepo, StoredResponsesItem } from '../../../../../repo/types.ts';
import { assert, assertEquals, assertRejects } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseOutputItem, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const apiKeyId = 'key_output';

type IteratorResultPromise = Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>;

const makePayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'gpt-test',
  input: 'hi',
  stream: true,
  store: true,
  ...overrides,
});

const makeInvocation = (overrides: {
  targetApi?: ResponsesInvocation['targetApi'];
  payload?: ResponsesPayload;
  responsesNewItems?: StoredResponsesItem[];
} = {}): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: overrides.targetApi ?? 'responses',
  model: 'gpt-test',
  upstream: 'up_native',
  upstreamModel: stubUpstreamModel(),
  provider: stubProvider(),
  enabledFlags: new Set<string>(),
  responsesNewItems: overrides.responsesNewItems ?? [],
  payload: overrides.payload ?? makePayload(),
  headers: {},
});

const makeRequest = (): RequestContext => ({
  requestStartedAt: 0,
  apiKeyId,
  runtimeLocation: 'test',
  clientStream: true,
});

const messageItem = (id: string, text: string): Extract<ResponseOutputItem, { type: 'message' }> => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const response = (output: ResponseOutputItem[], status: ResponsesResult['status'] = 'completed'): ResponsesResult => ({
  id: 'resp_test',
  object: 'response',
  model: 'gpt-test',
  status,
  output,
  output_text: '',
  error: status === 'failed' ? { message: 'failed', code: 'server_error' } : null,
  incomplete_details: null,
});

const frame = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> => eventFrame(event);

const framesFrom = async function* (events: readonly ResponsesStreamEvent[]) {
  for (const event of events) yield frame(event);
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const collected: ResponsesStreamEvent[] = [];
  for await (const item of events) {
    if (item.type === 'event') collected.push(item.event);
  }
  return collected;
};

const eventAt = <TType extends ResponsesStreamEvent['type']>(
  events: readonly ResponsesStreamEvent[],
  type: TType,
): Extract<ResponsesStreamEvent, { type: TType }> => {
  const event = events.find((candidate): candidate is Extract<ResponsesStreamEvent, { type: TType }> => candidate.type === type);
  assert(event, `expected ${type}`);
  return event;
};

const promiseStateAfterMicrotasks = async (promise: IteratorResultPromise): Promise<'pending' | 'fulfilled' | 'rejected'> => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );

  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    if (state !== 'pending') return state;
  }
  return state;
};

class ControlledResponsesItemsRepo implements ResponsesItemsRepo {
  calls: StoredResponsesItem[][] = [];
  resolveInsert: (() => void) | undefined;
  rejectInsert: ((error: unknown) => void) | undefined;

  lookupMany(): Promise<StoredResponsesItem[]> {
    return Promise.resolve([]);
  }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    this.calls.push(items.map(item => structuredClone(item)));
    return new Promise((resolve, reject) => {
      this.resolveInsert = resolve;
      this.rejectInsert = reject;
    });
  }

  clearPayloadOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteAll(): Promise<void> {
    return Promise.resolve();
  }
}

test('rewrites output item ids consistently across added, child, done, terminal, and stored row JSON', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: original.id!, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation(), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  assert(isStoredResponsesItemId(storedId));
  assertEquals(parseStoredResponsesItemId(storedId)?.prefix, 'msg');
  assertEquals(eventAt(events, 'response.output_item.added').item.id, storedId);
  assertEquals(eventAt(events, 'response.output_text.delta').item_id, storedId);
  assertEquals(eventAt(events, 'response.completed').response.output[0].id, storedId);

  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, 'up_native');
  assertEquals(row.upstreamItemId, original.id);
  assertEquals(row.payload, { item: { ...original, id: storedId } });
});

test('inserts rows before yielding a successful terminal event', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const iterator = storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation(), makeRequest())[Symbol.asyncIterator]();

  const firstFrame = iterator.next();

  assertEquals(await promiseStateAfterMicrotasks(firstFrame), 'pending');
  assertEquals(controlled.calls.length, 1);
  controlled.resolveInsert?.();
  assertEquals(((await firstFrame).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
});

test('insert failure prevents yielding any rewritten stored item frames', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const iterator = storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation(), makeRequest())[Symbol.asyncIterator]();

  const firstFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(firstFrame), 'pending');
  controlled.rejectInsert?.(new Error('insert failed'));

  await assertRejects(() => firstFrame, Error, 'insert failed');
});

test('does not insert rows for failed streams without completed output items', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.failed', response: response([], 'failed') },
  ]), makeInvocation(), makeRequest()));

  assertEquals(events.at(-1)?.type, 'response.failed');
  assertEquals(controlled.calls.length, 0);
});

test('persists completed output items before yielding them even if the stream later fails', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const iterator = storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.failed', response: response([], 'failed') },
  ]), makeInvocation(), makeRequest())[Symbol.asyncIterator]();

  const firstFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(firstFrame), 'pending');
  assertEquals(controlled.calls.length, 1);
  controlled.resolveInsert?.();

  assertEquals(((await firstFrame).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
  assertEquals(((await iterator.next()).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
});

test('store false creates metadata rows with null payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation({ payload: makePayload({ store: false }) }), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, null);
  assertEquals(row.upstreamItemId, original.id);
});

test('terminal output items missing done frames are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_only', 'late');

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation(), makeRequest()));

  const storedId = eventAt(events, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: { ...original, id: storedId } });
});

test('items without upstream ids each receive their own stored id', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const first = { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'same' }] };
  const second = { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'same' }] };

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.completed', response: response([first, second]) },
  ]), makeInvocation({ targetApi: 'messages' }), makeRequest()));

  const done = events.filter((event): event is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> => event.type === 'response.output_item.done');
  assert(done[0].item.id !== done[1].item.id);
  assert(isStoredResponsesItemId(done[0].item.id!));
  assert(isStoredResponsesItemId(done[1].item.id!));
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [done[0].item.id!, done[1].item.id!]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].upstreamId, null);
  assertEquals(rows[1].upstreamId, null);
});

test('responses via non-responses target output rows do not claim upstream ownership', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('msg_0', 'translated');

  const events = await collectEvents(storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeInvocation({ targetApi: 'messages' }), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
});
