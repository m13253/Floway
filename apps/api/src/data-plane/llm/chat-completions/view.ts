import type { ResponsesItemsView } from '../responses/items/view.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

// Chat-Completions-as-Responses-items view used by `planChatCompletionsRouting`.
// Visit-only: the read-only view never rebuilds the source-shape messages, it
// only walks each assistant `reasoning_items[]` carrier so the affinity
// classifier can read their gateway-stored ids.
export const chatCompletionsViaResponsesItemsView: ResponsesItemsView<readonly ChatCompletionsMessage[]> = {
  visitAsResponsesItems: async (messages, visit) => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) continue;

      for (const item of message.reasoning_items) {
        if (!item.id) continue;
        visit({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
      }
    }
  },
};
