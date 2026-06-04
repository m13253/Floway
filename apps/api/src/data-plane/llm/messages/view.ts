import type { ResponsesItemsView } from '../responses/items/view.ts';
import type { MessagesAssistantContentBlock, MessagesMessage } from '@floway-dev/protocols/messages';
import { unpackReasoningSignature } from '@floway-dev/translate/messages-and-responses';

// Messages-as-Responses-items view used by `planMessagesRouting`. Visit-only:
// the read-only view never rebuilds the source-shape items, it only walks the
// stored assistant reasoning blocks so the affinity classifier can read their
// gateway-stored ids.
//
// A `${enc}@${id}` thinking signature or redacted_thinking blob never
// originates from a native Anthropic Messages model — Anthropic emits opaque
// signatures with no `@`. The carrier exists only because our own
// messages-via-responses translation packed a Responses reasoning id into the
// signature, or the session previously passed through another gateway using
// the same interop layout. A foreign gateway's id is not one of our stored
// ids, so it does not resolve here and the block surfaces no reasoning item.
const reasoningCarrier = (block: MessagesAssistantContentBlock): { id: string; encryptedContent: string; thinking: string } | null => {
  const carrier = block.type === 'thinking' ? block.signature : block.type === 'redacted_thinking' ? block.data : undefined;
  if (carrier === undefined) return null;

  const { id, encryptedContent } = unpackReasoningSignature(carrier);
  if (id === null) return null;

  return { id, encryptedContent, thinking: block.type === 'thinking' ? block.thinking : '' };
};

export const messagesViaResponsesItemsView: ResponsesItemsView<readonly MessagesMessage[]> = {
  visitAsResponsesItems: async (messages, visit) => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        const carrier = reasoningCarrier(block);
        if (carrier === null) continue;

        visit({
          type: 'reasoning',
          id: carrier.id,
          summary: carrier.thinking ? [{ type: 'summary_text', text: carrier.thinking }] : [],
          ...(carrier.encryptedContent ? { encrypted_content: carrier.encryptedContent } : {}),
        });
      }
    }
  },
};
