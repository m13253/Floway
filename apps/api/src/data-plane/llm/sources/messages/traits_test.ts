import { test } from 'vitest';

import { messagesFailureEnvelope } from './traits.ts';
import { assertEquals } from '../../../../test-assert.ts';

// The same `LlmServeFailure` the Responses source renders as an OpenAI body must
// answer in the Anthropic envelope here, never borrowing OpenAI's shape — the
// failure carries no pre-shaped body, so each protocol owns its own rendering.

test('Messages renders item-not-found in the Anthropic envelope', () => {
  assertEquals(messagesFailureEnvelope({ kind: 'item-not-found', itemId: 'rs_x' }, '/messages'), {
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: "Item with id 'rs_x' not found." } },
  });
});
