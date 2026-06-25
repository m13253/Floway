import type { ModelAliasRules } from '../../../control-plane/model-aliases/types.ts';
import { FLOWAY_EXTENSION_FIELDS } from '@floway-dev/protocols/extensions';

export interface SanitizeTraceCtx {
  readonly aliasName?: string;
  readonly emit: (line: { alias?: string; field: string; targetProtocol: string }) => void;
}

// Default per-request trace that flows through the gateway's console logger.
// `aliasName` rides through to the trace line so an operator inspecting logs
// can correlate the drop with the matched alias; when no alias matched the
// field still appears (residue from a client-sent extension), just without
// alias attribution.
export const createSanitizeTraceCtx = (aliasName: string | undefined): SanitizeTraceCtx => ({
  ...(aliasName !== undefined ? { aliasName } : {}),
  emit: line => console.warn('floway.alias.drop', JSON.stringify(line)),
});

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

// Walks the alias rules object and emits one trace line per non-empty rule
// field. Used by inbound surfaces that have no protocol-extension slots for
// the rules in the first place (embeddings, images, /v1/completions) — the
// rules are structurally dropped before the upstream call, and this helper
// gives the operator the same `floway.alias.drop` signal the chat
// sanitizers produce when they strip extension residue.
export const traceAllRulesDropped = (
  rules: ModelAliasRules,
  targetProtocol: string,
  trace: SanitizeTraceCtx,
): void => {
  if (rules.reasoning) {
    for (const key of Object.keys(rules.reasoning)) {
      trace.emit({ alias: trace.aliasName, field: `reasoning.${key}`, targetProtocol });
    }
  }
  if (rules.verbosity !== undefined) trace.emit({ alias: trace.aliasName, field: 'verbosity', targetProtocol });
  if (rules.serviceTier !== undefined) trace.emit({ alias: trace.aliasName, field: 'serviceTier', targetProtocol });
  if (rules.anthropicSpeed !== undefined) trace.emit({ alias: trace.aliasName, field: 'anthropicSpeed', targetProtocol });
  if (rules.anthropicBeta?.length) trace.emit({ alias: trace.aliasName, field: 'anthropicBeta', targetProtocol });
};
