import { describe, expect, it } from 'vitest';

import {
  collectChatCompletionsStream,
  collectGeminiStream,
  collectMessagesStream,
  collectResponsesStream,
  detectCollectKind,
} from './collect.ts';
import type { DumpStreamEvent } from '@floway-dev/protocols/dump';

const ev = (event: string | null, data: unknown, ts = 0): DumpStreamEvent => ({
  event,
  data: typeof data === 'string' ? data : JSON.stringify(data),
  ts,
});

describe('collect', () => {
  it('folds Messages text_deltas and surfaces max_tokens', () => {
    const out = collectMessagesStream([
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world!' } }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    ]);
    expect(out.text).toBe('Hello, world!');
    expect(out.truncated).toBe(true);
    expect(out.error).toBeNull();
  });

  it('folds Chat Completions deltas and finish_reason length', () => {
    const out = collectChatCompletionsStream([
      ev(null, { choices: [{ delta: { content: 'a' } }] }),
      ev(null, { choices: [{ delta: { content: 'bc' } }] }),
      ev(null, { choices: [{ delta: {}, finish_reason: 'length' }] }),
    ]);
    expect(out.text).toBe('abc');
    expect(out.truncated).toBe(true);
  });

  it('prefers the response.completed snapshot over delta concatenation when both are present', () => {
    const out = collectResponsesStream([
      ev('response.output_text.delta', { delta: 'partial' }),
      ev('response.completed', {
        response: {
          output: [{
            content: [
              { type: 'output_text', text: 'partial complete' },
            ],
          }],
        },
      }),
    ]);
    expect(out.text).toBe('partial complete');
  });

  it('marks Gemini truncation on MAX_TOKENS', () => {
    const out = collectGeminiStream([
      ev(null, { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
      ev(null, { candidates: [{ content: { parts: [{ text: ' there' }] }, finishReason: 'MAX_TOKENS' }] }),
    ]);
    expect(out.text).toBe('hi there');
    expect(out.truncated).toBe(true);
  });

  it('detects protocol from path', () => {
    expect(detectCollectKind('/v1/messages')).toBe('messages');
    expect(detectCollectKind('/v1/responses')).toBe('responses');
    expect(detectCollectKind('/v1/chat/completions')).toBe('chat-completions');
    expect(detectCollectKind('/v1beta/models/gemini-pro:streamGenerateContent')).toBe('gemini');
    expect(detectCollectKind('/v1/something-else')).toBeNull();
  });

  it('captures error frames into outcome.error', () => {
    const out = collectMessagesStream([
      ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'too busy' } }),
    ]);
    expect(out.error).toBe('too busy');
  });
});
