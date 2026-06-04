import { describe, expect, it } from 'vitest';

import { responsesItemsView } from './view.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

describe('responsesItemsView', () => {
  it('visits items in order', async () => {
    const items: ResponsesInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'reasoning',
        id: 'rs_abc123',
        summary: [{ type: 'summary_text', text: 'thinking...' }],
      },
      {
        type: 'item_reference',
        id: 'msg_xyz456',
      },
    ];

    const visited: ResponsesInputItem[] = [];
    await responsesItemsView.visitAsResponsesItems(items, item => { visited.push(item); });

    expect(visited).toHaveLength(3);
    expect(visited[0]).toBe(items[0]);
    expect(visited[1]).toBe(items[1]);
    expect(visited[2]).toBe(items[2]);
  });

  it('visits no items for an empty array', async () => {
    const visited: ResponsesInputItem[] = [];
    await responsesItemsView.visitAsResponsesItems([], item => { visited.push(item); });
    expect(visited).toHaveLength(0);
  });

  it('preserves item shapes', async () => {
    const message: ResponsesInputItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'response' }],
    };
    const reasoning: ResponsesInputItem = {
      type: 'reasoning',
      id: 'rs_def789',
      summary: [],
      encrypted_content: 'opaque-blob',
    };
    const reference: ResponsesInputItem = {
      type: 'item_reference',
      id: 'fc_ref001',
    };

    const visited: ResponsesInputItem[] = [];
    await responsesItemsView.visitAsResponsesItems([message, reasoning, reference], item => { visited.push(item); });

    expect(visited[0]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(visited[1]).toMatchObject({ type: 'reasoning', id: 'rs_def789', encrypted_content: 'opaque-blob' });
    expect(visited[2]).toMatchObject({ type: 'item_reference', id: 'fc_ref001' });
  });
});
