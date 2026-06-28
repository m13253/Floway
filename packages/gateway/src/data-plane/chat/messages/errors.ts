import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ApiErrorResult, ExecuteResult } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

// Anthropic Messages error envelope used to render pre-stream
// `ChatServeFailure`s. These are gateway-synthesized rather than received
// from any upstream — `source: 'gateway'` so the dump labels them as such.
const anthropicErrorResult = (
  status: number,
  type: string,
  message: string,
): ApiErrorResult => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message },
  })),
});

// Translator surfaced a caller-input violation (unsupported content part,
// disallowed role, missing required field, etc.). Render as a 400
// invalid_request_error so the caller sees a protocol-shaped failure
// instead of the internal-error 502 envelope.
export const translatorInputErrorResult = (
  error: TranslatorInputError,
): ApiErrorResult =>
  anthropicErrorResult(400, 'invalid_request_error', error.message);

// `endpoint` selects between `/messages` and `/messages/count_tokens` only in
// the `model-unsupported` message string.
export const renderMessagesFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => {
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  switch (failure.kind) {
  case 'item-not-found':
    return anthropicErrorResult(400, 'invalid_request_error', `Item with id '${failure.itemId}' not found.`);
  case 'routing-unavailable':
    return anthropicErrorResult(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicErrorResult(404, 'not_found_error', appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return anthropicErrorResult(400, 'invalid_request_error', appendFailedUpstreams(`Model ${failure.model} does not support the ${endpointPath} endpoint.`, failure.failedUpstreams));
  }
};
