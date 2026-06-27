import { FLOWAY_EXTENSION_FIELDS } from '@floway-dev/protocols/extensions';

export interface SanitizeTraceCtx {
  readonly emit: (line: { field: string; targetProtocol: string }) => void;
}

// Default per-request trace that flows through the gateway's console logger.
export const createSanitizeTraceCtx = (): SanitizeTraceCtx => ({
  emit: line => console.warn('floway.extension.drop', JSON.stringify(line)),
});

const stripKeys = (
  body: Record<string, unknown>,
  keys: readonly string[],
  targetProtocol: string,
  trace: SanitizeTraceCtx | undefined,
): void => {
  for (const key of keys) {
    if (key in body) {
      delete body[key];
      trace?.emit({ field: key, targetProtocol });
    }
  }
};

export const sanitizeForChatCompletionsUpstream = (body: Record<string, unknown>, trace?: SanitizeTraceCtx): void => {
  stripKeys(body, FLOWAY_EXTENSION_FIELDS.chatCompletions, 'chat-completions', trace);
};

export const sanitizeForResponsesUpstream = (body: Record<string, unknown>, trace?: SanitizeTraceCtx): void => {
  stripKeys(body, FLOWAY_EXTENSION_FIELDS.responses, 'responses', trace);
};

export const sanitizeForMessagesUpstream = (body: Record<string, unknown>, trace?: SanitizeTraceCtx): void => {
  stripKeys(body, FLOWAY_EXTENSION_FIELDS.messages, 'messages', trace);
};
