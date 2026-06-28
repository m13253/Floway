import { test } from 'vitest';

import { translatorInputErrorResult } from './errors.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(result.body));

test('translatorInputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `input` param', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError('Responses → Messages translator does not accept image_generation_call input items.'),
  );

  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.status, 400);
  assertEquals(bodyOf(result), {
    error: {
      message: 'Responses → Messages translator does not accept image_generation_call input items.',
      type: 'invalid_request_error',
      param: 'input',
      code: null,
    },
  });
});

test('translatorInputErrorResult honors an explicit param from the translator', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError('content block not supported', { param: 'input[1].content[0]' }),
  );

  assertEquals(bodyOf(result), {
    error: {
      message: 'content block not supported',
      type: 'invalid_request_error',
      param: 'input[1].content[0]',
      code: null,
    },
  });
});
