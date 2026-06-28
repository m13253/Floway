import { test } from 'vitest';

import { translatorInputErrorResult } from './errors.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(result.body));

test('translatorInputErrorResult renders an Anthropic 400 invalid_request_error envelope', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError('Chat Completions → Messages translator does not accept image content parts in system or developer messages.'),
  );

  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.status, 400);
  assertEquals(result.headers.get('content-type'), 'application/json');
  assertEquals(bodyOf(result), {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Chat Completions → Messages translator does not accept image content parts in system or developer messages.',
    },
  });
});
