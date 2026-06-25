// Compact-shim — simulates a `response.compaction` envelope against upstreams
// that have no native compaction wire. Gated by the per-upstream
// `responses-compact-shim` flag.
//
// Flow when the flag is on:
//   1. Inbound: walk `payload.input` for `compaction` items whose
//      `encrypted_content` decodes as our base64url-JSON marker. Each match
//      is replaced inline with the items it originally encoded — so a
//      subsequent turn that echoes back the synthesized compaction sees the
//      summarized history.
//   2. Outbound: when `invocation.action === 'compact'`, flip the action to
//      'generate', swap in the SUMMARIZATION_PROMPT (vendored from
//      openai/codex), and force `store: false` so the ephemeral
//      summarization turn does not pollute the upstream's conversation
//      history. Call `run()` to drive the chain through the normal generate
//      path; collect the resulting summary text; pack a single user-role
//      message containing the summary into a synthetic
//      `response.compaction` envelope; re-tag `invocation.action` back to
//      'compact' so the gateway's snapshot layer treats it correctly.
//
// Foreign-upstream blobs (opaque strings that fail base64url+JSON decoding
// or fail the array-of-objects-with-string-types schema below) round-trip
// untouched, so the operator can selectively turn the flag off for codex /
// copilot / azure / custom upstreams that natively support compaction.

import type { ResponsesInterceptor, ResponsesInvocation } from './types.ts';
import { isJsonObject } from '../../../../shared/json-helpers.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, type ResponsesInputItem, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

// ── Encoding helpers ──────────────────────────────────────────────────────────
//
// Mirrors the bytesToBase64Url / base64UrlToBytes pair in messages/interceptors/
// web-search-shim.ts. Plain base64url(JSON) with no envelope or prefix marker;
// foreign payloads are detected purely by decode failure or schema mismatch.

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
};

export const encodePayload = (payload: unknown): string =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));

const decodePayload = (value: string): unknown | null => {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

// Structural validator: a shim payload is an array of input-item objects each
// carrying a `type` field. Strict enough that a foreign opaque blob can't
// accidentally decode + parse + validate.
const isShimCompactionPayload = (value: unknown): value is ResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string');

// ── Inbound expansion ─────────────────────────────────────────────────────────

export const expandShimCompactionItems = (payload: ResponsesPayload): ResponsesPayload => {
  if (typeof payload.input === 'string') return payload;

  const rewritten: ResponsesInputItem[] = [];
  let changed = false;
  for (const item of payload.input) {
    if (item.type !== 'compaction') {
      rewritten.push(item);
      continue;
    }
    const encryptedContent = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof encryptedContent !== 'string') {
      rewritten.push(item);
      continue;
    }
    const decoded = decodePayload(encryptedContent);
    if (!isShimCompactionPayload(decoded)) {
      // Foreign blob — leave untouched so a native-compaction upstream still
      // sees its own encrypted_content verbatim.
      rewritten.push(item);
      continue;
    }
    rewritten.push(...decoded);
    changed = true;
  }
  return changed ? { ...payload, input: rewritten } : payload;
};

// ── Outbound summarization ────────────────────────────────────────────────────

type ChainRun = () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;

// Extracts the summary text from the upstream's response to the
// SUMMARIZATION_PROMPT.
const extractTextFromResult = (result: ResponsesResult): string => {
  const parts: string[] = [];
  for (const item of result.output) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text);
    }
  }
  return parts.join('');
};

const buildCompactionEnvelope = (summaryText: string, upstream: ResponsesResult): ResponsesResult => {
  const summaryItem: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: summaryText }],
  };
  const encryptedContent = encodePayload([summaryItem]);

  // Drop the SDK-only `output_text` alias that some upstreams emit — its
  // value is the upstream's summary plaintext, which has no place on a
  // synthesized `response.compaction` envelope whose `output` carries only
  // an opaque compaction item. Same destructure precedent at
  // `protocols/responses/from-result.ts:14`.
  const { output_text: _droppedOutputText, ...upstreamBase } = upstream;

  return {
    ...upstreamBase,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    status: 'completed',
    output: [
      {
        type: 'compaction',
        id: `cmp_${crypto.randomUUID()}`,
        encrypted_content: encryptedContent,
      },
    ] as unknown as ResponsesResult['output'],
    incomplete_details: null,
    error: null,
  };
};

const simulateCompaction = async (ctx: ResponsesInvocation, run: ChainRun): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const originalPayload = ctx.payload;

  // Strip compaction_trigger items — the upstream is about to see a plain
  // generate turn against SUMMARIZATION_PROMPT.
  const historyItems = Array.isArray(originalPayload.input)
    ? originalPayload.input.filter(item => item.type !== 'compaction_trigger')
    : [];

  ctx.payload = {
    ...originalPayload,
    input: historyItems,
    instructions: SUMMARIZATION_PROMPT,
    // Do not persist the ephemeral summarization turn in the upstream's
    // conversation history.
    store: false,
  };
  // Pivot the action so the inner dispatch routes to the upstream's
  // generate wire instead of its compact wire.
  ctx.action = 'generate';

  let upstreamResult: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;
  try {
    upstreamResult = await run();
  } finally {
    ctx.payload = originalPayload;
    // Re-tag the action so the gateway's post-chain snapshot derivation
    // picks 'replace'. Restored in `finally` alongside `payload` so the
    // outer state is symmetric whether the inner call resolves or throws.
    ctx.action = 'compact';
  }

  if (upstreamResult.type !== 'events') {
    // api-error / internal-error from the upstream propagate so the client
    // learns the compaction failed rather than receiving a silent empty
    // envelope.
    return upstreamResult;
  }

  const collected = await collectResponsesProtocolEventsToResult(upstreamResult.events);
  const summaryText = extractTextFromResult(collected);
  const synthesized = buildCompactionEnvelope(summaryText, collected);

  return {
    ...upstreamResult,
    events: syntheticEventsFromResult(synthesized),
  };
};

export const withResponsesCompactShim: ResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.binding.enabledFlags.has('responses-compact-shim')) return await run();

  // Inbound: expand any prior shim-encoded compactions back into their
  // original items so the upstream sees the summarized history.
  ctx.payload = expandShimCompactionItems(ctx.payload);

  if (ctx.action !== 'compact') return await run();

  return await simulateCompaction(ctx, run);
};
