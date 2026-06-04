import { describe, expect, it } from 'vitest';

import { messagesViaResponsesItemsView } from './view.ts';
import type { MessagesMessage } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { packReasoningSignature } from '@floway-dev/translate/messages-and-responses';

describe('messagesViaResponsesItemsView', () => {
  it('surfaces gateway-stored reasoning carriers in order', async () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan A', signature: packReasoningSignature('rs_1', 'enc1') },
          { type: 'text', text: 'ok' },
          { type: 'redacted_thinking', data: packReasoningSignature('rs_2', 'enc2') },
        ],
      },
    ];

    const visited: ResponsesInputItem[] = [];
    await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => { visited.push(item); });

    expect(visited).toHaveLength(2);
    expect(visited[0]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'plan A' }],
      encrypted_content: 'enc1',
    });
    expect(visited[1]).toEqual({
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      encrypted_content: 'enc2',
    });
  });

  it('skips non-assistant messages and string-content assistants', async () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: 'just text, no blocks' },
    ];

    const visited: ResponsesInputItem[] = [];
    await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => { visited.push(item); });

    expect(visited).toHaveLength(0);
  });

  it('skips opaque native signatures with no packed id', async () => {
    const messages: MessagesMessage[] = [
      {
        role: 'assistant',
        content: [
          // No `@` in the signature — this is a genuine upstream blob, not a
          // gateway-packed carrier; the view must not synthesise an id for it.
          { type: 'thinking', thinking: 'native trace', signature: 'opaque-no-at' },
        ],
      },
    ];

    const visited: ResponsesInputItem[] = [];
    await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => { visited.push(item); });

    expect(visited).toHaveLength(0);
  });

  it('omits encrypted_content when the packed value is empty', async () => {
    const messages: MessagesMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'idea', signature: packReasoningSignature('rs_only_id', '') }],
      },
    ];

    const visited: ResponsesInputItem[] = [];
    await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => { visited.push(item); });

    expect(visited).toHaveLength(1);
    expect(visited[0]).toEqual({
      type: 'reasoning',
      id: 'rs_only_id',
      summary: [{ type: 'summary_text', text: 'idea' }],
    });
  });
});
