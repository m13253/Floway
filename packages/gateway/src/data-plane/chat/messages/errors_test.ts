import { test } from 'vitest';

import { translatorInputErrorResult } from './errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const apiErrorOf = (result: ReturnType<typeof translatorInputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(apiErrorOf(result).body));

test('translatorInputErrorResult renders an Anthropic 400 invalid_request_error envelope', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError('Chat Completions → Messages translator does not accept image content parts in system or developer messages.'),
  );
  const apiError = apiErrorOf(result);

  assertEquals(apiError.type, 'api-error');
  assertEquals(apiError.source, 'gateway');
  assertEquals(apiError.status, 400);
  assertEquals(apiError.headers.get('content-type'), 'application/json');
  assertEquals(bodyOf(result), {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Chat Completions → Messages translator does not accept image content parts in system or developer messages.',
    },
  });
});
