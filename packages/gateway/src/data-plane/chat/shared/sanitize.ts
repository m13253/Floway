import { FLOWAY_EXTENSION_FIELDS } from '@floway-dev/protocols/extensions';

export interface SanitizeTraceCtx {
  readonly aliasName?: string;
  readonly emit: (line: { alias?: string; field: string; targetProtocol: string }) => void;
}

const stripKeys = (
  body: Record<string, unknown>,
  keys: readonly string[],
  targetProtocol: string,
  trace: SanitizeTraceCtx | undefined,
  fieldPrefix: string = '',
): void => {
  for (const key of keys) {
    if (key in body) {
      delete body[key];
      trace?.emit({ alias: trace.aliasName, field: `${fieldPrefix}${key}`, targetProtocol });
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

export const sanitizeForGeminiUpstream = (body: Record<string, unknown>, trace?: SanitizeTraceCtx): void => {
  stripKeys(body, FLOWAY_EXTENSION_FIELDS.gemini.topLevel, 'gemini', trace);
  const generationConfig = body.generationConfig;
  if (generationConfig && typeof generationConfig === 'object') {
    stripKeys(generationConfig as Record<string, unknown>, FLOWAY_EXTENSION_FIELDS.gemini.generationConfig, 'gemini', trace, 'generationConfig.');
  }
};
