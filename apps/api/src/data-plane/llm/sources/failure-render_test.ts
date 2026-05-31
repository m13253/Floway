import { test } from 'vitest';

import { messagesFailureEnvelope } from './messages/traits.ts';
import { responsesTraits } from './responses/traits.ts';
import { assertEquals } from '../../../test-assert.ts';

// The same `LlmServeFailure` is rendered into each source's own error envelope.
// These pin the two cells that carry external contracts: the Responses body
// must byte-match OpenAI's native "not found" response, and Messages must
// answer in the Anthropic envelope rather than borrowing OpenAI's.

const decodeUpstreamError = (result: ReturnType<typeof responsesTraits.renderFailure>) => {
  if (result.type !== 'upstream-error') throw new Error(`expected upstream-error, got ${result.type}`);
  return { status: result.status, body: JSON.parse(new TextDecoder().decode(result.body)) as unknown };
};

test('Responses renders item-not-found as the byte-exact OpenAI native body', () => {
  const { status, body } = decodeUpstreamError(responsesTraits.renderFailure({ kind: 'item-not-found', itemId: 'rs_x' }));
  assertEquals(status, 404);
  assertEquals(body, { error: { message: "Item with id 'rs_x' not found.", type: 'invalid_request_error', param: 'input', code: null } });
});

test('Responses tags routing-unavailable with the gateway-specific code', () => {
  const { status, body } = decodeUpstreamError(responsesTraits.renderFailure({ kind: 'routing-unavailable', message: 'no upstream' }));
  assertEquals(status, 400);
  assertEquals(body, { error: { message: 'no upstream', type: 'invalid_request_error', param: 'input', code: 'responses_item_routing_unavailable' } });
});

test('Messages renders the same failure in the Anthropic envelope, not OpenAI', () => {
  assertEquals(messagesFailureEnvelope({ kind: 'item-not-found', itemId: 'rs_x' }, '/messages'), {
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: "Item with id 'rs_x' not found." } },
  });
});
