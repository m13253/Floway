import type { GeminiCandidate, GeminiPart, GeminiResult } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';

const parseChunk = (raw: DumpStreamEvent): GeminiResult | null => {
  const data = raw.data.trim();
  if (data.length === 0) return null;
  return JSON.parse(data) as GeminiResult;
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

export const collectGeminiStream = (events: readonly DumpStreamEvent[]): GeminiResult => {
  const candidates = new Map<number, GeminiCandidate>();
  let envelope: Pick<GeminiResult, 'modelVersion' | 'responseId'> = {};
  let usageMetadata: GeminiResult['usageMetadata'];

  for (const raw of events) {
    const chunk = parseChunk(raw);
    if (chunk === null) continue;

    if (chunk.modelVersion !== undefined) envelope = { ...envelope, modelVersion: chunk.modelVersion };
    if (chunk.responseId !== undefined) envelope = { ...envelope, responseId: chunk.responseId };
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;

    for (const candidate of chunk.candidates ?? []) {
      candidates.set(candidate.index, mergeCandidate(candidates.get(candidate.index), candidate));
    }
  }

  const sortedCandidates = [...candidates.values()].sort((a, b) => a.index - b.index);
  return {
    ...envelope,
    ...(sortedCandidates.length > 0 ? { candidates: sortedCandidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};
