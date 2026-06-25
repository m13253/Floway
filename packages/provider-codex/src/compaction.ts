import { CODEX_REMOTE_COMPACTION_BETA } from './constants.ts';
import { type CallCodexResponsesOptions, callCodexResponses } from './fetch.ts';
import type { ResponsesCompactPayload, ResponsesInputItem, ResponsesPayload, ResponsesResult } from '@floway-dev/protocols/responses';
import { COMPACTION_TRIGGER, compactionResponse } from '@floway-dev/provider';

// Internal shape of the helper's return value. The boundary handler in
// provider.ts re-tags this onto the unified `ProviderResponsesResult`
// (`action: 'compact'`) before returning to the gateway.
export type CodexCompactionCallResult =
  | { ok: true; result: ResponsesResult; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

export interface CallCodexResponsesCompactOptions extends Omit<CallCodexResponsesOptions, 'body'> {
  body: Omit<ResponsesCompactPayload, 'model' | 'store'>;
}

// Codex natively understands the trailing `compaction_trigger` input item but
// only delivers the resulting `compaction` output via the streaming
// `response.output_item.done` event — `response.completed.output` is empty.
// We append the trigger, drive the same lifecycle helper as the normal
// /responses call (refresh + 429 quota + 401 retry), drain the SSE frames,
// and reshape via the shared `compactionResponse` helper so the envelope
// matches the Copilot path.
//
// Two Codex v2 compaction headers are set on every call here:
// - `x-codex-beta-features: remote_compaction_v2` — activates the v2 path;
//   the Codex CLI enables this on every request when
//   `[features].remote_compaction_v2 = true` (default since 0.137.0).
//   Source: the header literal lives in
//   https://github.com/openai/codex/blob/adccb464d075a39d5450d6bc879e3bb6c97ce14b/codex-rs/core/src/client.rs#L1830
//   and the `remote_compaction_v2` feature key in
//   https://github.com/openai/codex/blob/adccb464d075a39d5450d6bc879e3bb6c97ce14b/codex-rs/features/src/lib.rs#L1342-L1346
//   Test coverage in
//   https://github.com/openai/codex/blob/adccb464d075a39d5450d6bc879e3bb6c97ce14b/codex-rs/core/tests/suite/compact_remote.rs#L956-L962
// - `x-codex-turn-metadata` — JSON telemetry+routing hint with the
//   compaction-specific field set. The `CompactionTurnMetadata` shape and
//   its five fields (trigger/reason/implementation/phase/strategy) live in
//   https://github.com/openai/codex/blob/adccb464d075a39d5450d6bc879e3bb6c97ce14b/codex-rs/core/src/responses_metadata.rs#L73-L95
export const callCodexResponsesCompact = async (opts: CallCodexResponsesCompactOptions): Promise<CodexCompactionCallResult> => {
  const originalInput: ResponsesInputItem[] = typeof opts.body.input === 'string'
    ? [{ type: 'message', role: 'user', content: opts.body.input }]
    : opts.body.input;
  const triggerInput: ResponsesInputItem[] = [...originalInput, COMPACTION_TRIGGER];

  const triggeredBody: Omit<ResponsesPayload, 'model'> = { ...opts.body, input: triggerInput };

  const turnMetadata = {
    request_kind: 'compaction',
    compaction: {
      trigger: 'manual',
      reason: 'user_requested',
      implementation: 'responses_compaction_v2',
      phase: 'standalone_turn',
      strategy: 'memento',
    },
  };
  const result = await callCodexResponses({
    ...opts,
    body: triggeredBody,
    additionalHeaders: {
      'x-codex-beta-features': CODEX_REMOTE_COMPACTION_BETA,
      'x-codex-turn-metadata': JSON.stringify(turnMetadata),
      ...opts.additionalHeaders,
    },
  });

  if (!result.ok) return { ok: false, response: result.response, modelKey: opts.model.id };

  let baseEnvelope: ResponsesResult | null = null;
  const compactionItems: ResponsesResult['output'] = [];
  for await (const frame of result.events) {
    if (frame.type !== 'event') continue;
    const event = frame.event;
    if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      // Keep the latest envelope; `completed` carries usage + final status.
      baseEnvelope = event.response;
    } else if (event.type === 'response.output_item.done' && event.item.type === 'compaction') {
      compactionItems.push(event.item);
    }
  }

  if (!baseEnvelope) throw new Error('Codex compaction stream ended without a base response envelope');

  // Restitch the captured compaction item(s) into the envelope's empty output
  // so compactionResponse can find them; the shared helper enforces exactly
  // one and rebuilds the retained-message prefix.
  const synthesized: ResponsesResult = { ...baseEnvelope, output: compactionItems };
  return { ok: true, result: compactionResponse(originalInput, synthesized), modelKey: opts.model.id };
};
