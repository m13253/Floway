export interface GeminiPayload {
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiToolGroup[];
  toolConfig?: { functionCallingConfig?: GeminiFunctionCallingConfig };
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: GeminiSafetySetting[];
  cachedContent?: string;
  /** Floway protocol extension. Translated to Anthropic `speed` when routed to a Messages upstream; dropped elsewhere. See docs/superpowers/specs/2026-06-25-model-aliases-design.md. */
  anthropicSpeed?: string;
  /** Floway protocol extension. Translated to the Anthropic `anthropic-beta` header (list-merged, deduped) when routed to a Messages upstream; dropped elsewhere. See docs/superpowers/specs/2026-06-25-model-aliases-design.md. */
  anthropicBeta?: readonly string[];
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
  fileData?: { mimeType: string; fileUri: string };
  executableCode?: unknown;
  codeExecutionResult?: unknown;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseMimeType?: string;
  responseSchema?: unknown;
  thinkingConfig?: GeminiThinkingConfig;
  /** Floway protocol extension. Translated to OpenAI Chat `verbosity` / Responses `text.verbosity` when routed to those upstreams; dropped on Anthropic Messages and Gemini targets. See docs/superpowers/specs/2026-06-25-model-aliases-design.md. */
  verbosity?: string;
  /** Floway protocol extension. Translated to OpenAI Chat `service_tier` / Responses `service_tier` / Anthropic `service_tier` when routed to those upstreams; dropped on Gemini targets. See docs/superpowers/specs/2026-06-25-model-aliases-design.md. */
  serviceTier?: string;
}

export interface GeminiThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | string;
  includeThoughts?: boolean;
}

export interface GeminiFunctionCallingConfig {
  mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
  allowedFunctionNames?: string[];
}

export interface GeminiToolGroup {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: unknown;
  googleSearchRetrieval?: unknown;
  codeExecution?: unknown;
  computerUse?: unknown;
  urlContext?: unknown;
  fileSearch?: unknown;
  mcpServers?: unknown;
  googleMaps?: unknown;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiSafetySetting {
  category: string;
  threshold: string;
}

export interface GeminiResult {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

export interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: GeminiFinishReason;
  index: number;
}

export type GeminiFinishReason = 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | 'MALFORMED_FUNCTION_CALL' | 'FINISH_REASON_UNSPECIFIED';

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

export type GeminiStreamEvent = GeminiResult | GeminiErrorResponse;

export { GEMINI_MISSING_TERMINAL_MESSAGE, isGeminiErrorEvent, isGeminiTerminalEvent, collectGeminiProtocolEventsToResult } from './to-result.ts';
export { reassembleGeminiEvents } from './reassemble.ts';
export { geminiProtocolFrameToSSEFrame } from './to-sse.ts';
