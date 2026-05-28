import type { MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '@floway-dev/protocols/messages';
import type { ResponseInputReasoning, ResponsesReasoningItem } from '@floway-dev/protocols/responses';

export type MessagesReasoningBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock;

const RESPONSES_REASONING_SIGNATURE_PREFIX = 'floway:responses-reasoning:v1:';

const encodeBase64Url = (value: string): string =>
  btoa(value)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const decodeBase64Url = (value: string): string | null => {
  try {
    const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
    return atob(padded);
  } catch {
    return null;
  }
};

export const messagesReasoningSignature = (responsesReasoningId: string): string =>
  `${RESPONSES_REASONING_SIGNATURE_PREFIX}${encodeBase64Url(responsesReasoningId)}`;

export const messagesReasoningIdFromSignature = (signature: string | undefined): string | null => {
  if (!signature?.startsWith(RESPONSES_REASONING_SIGNATURE_PREFIX)) return null;

  const id = decodeBase64Url(signature.slice(RESPONSES_REASONING_SIGNATURE_PREFIX.length));
  return id && id.length > 0 ? id : null;
};

export const messagesReasoningBlockToResponsesReasoning = (block: MessagesReasoningBlock, index: number): ResponseInputReasoning | null => {
  if (block.type === 'redacted_thinking') return null;

  return {
    type: 'reasoning',
    id: messagesReasoningIdFromSignature(block.signature) ?? `rs_${index}`,
    summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
  };
};

export const responsesReasoningToMessagesBlock = (item: ResponsesReasoningItem): MessagesThinkingBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';

  return thinking ? { type: 'thinking', thinking, signature: messagesReasoningSignature(item.id) } : null;
};
