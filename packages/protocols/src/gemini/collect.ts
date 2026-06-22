import type { GeminiCandidate, GeminiErrorResponse, GeminiPart, GeminiResult } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// Gemini has no dedicated error event type: upstream errors arrive as a
// chunked-JSON `{ error: { code, message, status } }` object instead of a
// `GeminiResult`. Distinguish before treating a chunk as a result.
type ParsedChunk =
  | { kind: 'result'; chunk: GeminiResult }
  | { kind: 'error'; message: string }
  | { kind: 'empty' };

const isErrorChunk = (parsed: unknown): parsed is GeminiErrorResponse => {
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (!('error' in parsed)) return false;
  const err = (parsed as { error: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  // Require a message field so a legitimate result that happens to carry
  // an `error` extension key isn't misclassified.
  return 'message' in err && typeof (err as { message: unknown }).message === 'string';
};

const parseChunk = (raw: DumpStreamEvent): ParsedChunk => {
  const data = raw.data.trim();
  if (data.length === 0) return { kind: 'empty' };
  const parsed = JSON.parse(data) as unknown;
  if (isErrorChunk(parsed)) return { kind: 'error', message: parsed.error.message };
  return { kind: 'result', chunk: parsed as GeminiResult };
};

const mergePart = (existing: GeminiPart | undefined, incoming: GeminiPart): GeminiPart => {
  if (existing === undefined) return { ...incoming };
  if (typeof existing.text === 'string' && typeof incoming.text === 'string') {
    return { ...existing, ...incoming, text: existing.text + incoming.text };
  }
  return { ...existing, ...incoming };
};

const mergeCandidate = (existing: GeminiCandidate | undefined, incoming: GeminiCandidate): GeminiCandidate => {
  if (existing === undefined) {
    return {
      ...incoming,
      content: { ...incoming.content, parts: incoming.content.parts.map(part => ({ ...part })) },
    };
  }

  const parts: GeminiPart[] = existing.content.parts.slice();
  incoming.content.parts.forEach((part, i) => {
    parts[i] = mergePart(parts[i], part);
  });

  return {
    ...existing,
    ...incoming,
    content: {
      ...existing.content,
      ...incoming.content,
      parts,
    },
  };
};

export const collectGeminiStream = (events: readonly DumpStreamEvent[]): CollectOutcome<GeminiResult> => {
  const candidates = new Map<number, GeminiCandidate>();
  let envelope: Pick<GeminiResult, 'modelVersion' | 'responseId'> = {};
  let usageMetadata: GeminiResult['usageMetadata'];
  let error: string | null = null;
  let sawAnyResultChunk = false;

  for (const raw of events) {
    const parsed = parseChunk(raw);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'error') {
      error ??= parsed.message;
      continue;
    }

    sawAnyResultChunk = true;
    const { chunk } = parsed;
    if (chunk.modelVersion !== undefined) envelope = { ...envelope, modelVersion: chunk.modelVersion };
    if (chunk.responseId !== undefined) envelope = { ...envelope, responseId: chunk.responseId };
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;

    for (const candidate of chunk.candidates ?? []) {
      candidates.set(candidate.index, mergeCandidate(candidates.get(candidate.index), candidate));
    }
  }

  if (!sawAnyResultChunk) {
    return {
      result: null,
      error: error ?? 'no chunks in stream',
      truncated: true,
      warnings: [],
    };
  }

  const sortedCandidates = [...candidates.values()].sort((a, b) => a.index - b.index);
  // Without a dedicated terminal frame, the only signal that the stream
  // closed cleanly is a `finishReason` on every emitted candidate.
  const anyCandidateMissingFinish = sortedCandidates.some(c => c.finishReason === undefined);
  const truncated = anyCandidateMissingFinish || error !== null;

  return {
    result: {
      ...envelope,
      ...(sortedCandidates.length > 0 ? { candidates: sortedCandidates } : {}),
      ...(usageMetadata ? { usageMetadata } : {}),
    },
    error,
    truncated,
    warnings: [],
  };
};
