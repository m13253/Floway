import { describe, expect, it } from 'vitest';

import { collectByKind, detectCollectKind } from './collect.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { DumpStreamEvent } from '@floway-dev/protocols/dump';

const ev = (event: object | string, ts = 0): DumpStreamEvent =>
  typeof event === 'string' && event === '[DONE]'
    ? { frame: { type: 'done' }, ts }
    : { frame: { type: 'event', event } as ProtocolFrame<unknown>, ts };

// The heavy folding logic lives in `@floway-dev/protocols/dump-collect` and
// is exercised by that package's own tests; here we only verify that
// `collectByKind` wires each kind to the right protocol collector and
// returns the structured outcome the dashboard renders.
describe('collect', () => {
  it('routes messages to the Anthropic collector and surfaces the structured result', async () => {
    const out = await collectByKind('messages', [
      ev({
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', content: [],
          model: 'claude-test', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
      ev({ type: 'message_stop' }),
    ]);
    expect(out.error).toBeNull();
    expect(out.truncated).toBe(false);
    const result = out.result as { id: string; content: { type: string; text: string }[] };
    expect(result.id).toBe('msg_1');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('routes chat-completions to its collector and folds delta content', async () => {
    const out = await collectByKind('chat-completions', [
      ev({ id: 'c_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test', choices: [{ index: 0, delta: { content: 'abc' }, finish_reason: null }] }),
      ev({ id: 'c_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ev('[DONE]'),
    ]);
    expect(out.truncated).toBe(false);
    const result = out.result as { choices: { message: { content: string }; finish_reason: string }[] };
    expect(result.choices[0].message.content).toBe('abc');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('routes responses to its collector and adopts the terminal payload', async () => {
    const base = {
      id: 'r_1', object: 'response', model: 'gpt-test', output: [],
      status: 'in_progress', error: null, incomplete_details: null,
    };
    const out = await collectByKind('responses', [
      ev({ type: 'response.created', response: base }),
      ev({
        type: 'response.completed',
        response: { ...base, status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] },
      }),
    ]);
    expect(out.truncated).toBe(false);
    const result = out.result as { status: string; output: { type: string; content: { type: string; text: string }[] }[] };
    expect(result.status).toBe('completed');
    expect(result.output[0].content[0]).toEqual({ type: 'output_text', text: 'done' });
  });

  it('routes gemini to its collector and concatenates candidate text', async () => {
    const out = await collectByKind('gemini', [
      ev({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] }),
      ev({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' there' }] }, finishReason: 'STOP' }] }),
    ]);
    expect(out.truncated).toBe(false);
    const result = out.result as { candidates: { content: { parts: { text: string }[] } }[] };
    expect(result.candidates[0].content.parts).toEqual([{ text: 'hi there' }]);
  });

  it('detects protocol from path', () => {
    expect(detectCollectKind('/v1/messages')).toBe('messages');
    expect(detectCollectKind('/v1/responses')).toBe('responses');
    expect(detectCollectKind('/v1/chat/completions')).toBe('chat-completions');
    expect(detectCollectKind('/v1beta/models/gemini-pro:streamGenerateContent')).toBe('gemini');
    expect(detectCollectKind('/v1/something-else')).toBeNull();
  });
});
