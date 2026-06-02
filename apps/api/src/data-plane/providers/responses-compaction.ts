import type { ProviderCallResult } from './types.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

// A `/responses/compact` upstream answer is a single non-streaming
// `response.compaction` body, but the target pipeline only accepts
// `text/event-stream` (it forces stream=true on every LLM endpoint). Rather
// than teach the pipeline a non-SSE side path, every provider projects its
// compaction envelope onto SSE here.
//
// The output items are emitted as opaque `output_item.added`/`.done` carriers
// rather than via the terminal fast-path: a compaction envelope's retained
// items are input-shaped user/developer/system messages, which the fast-path
// expander (`responsesResultToEvents`) would rewrite as assistant output
// messages with synthesized text deltas. Emitting them verbatim preserves their
// role and content while still letting the source-serve store path mint stored
// ids and persist each one (the compaction blob with forced upstream affinity).
export const compactionResultToSse = (result: ResponsesResult): Response => {
  const started = { ...result, status: 'in_progress', output: [], output_text: '' };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: started },
    { type: 'response.in_progress', response: started },
  ];
  result.output.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item });
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response: result });

  const body = events
    .map((event, sequence_number) => `event: ${event.type as string}\ndata: ${JSON.stringify({ ...event, sequence_number })}`)
    .concat('data: [DONE]')
    .join('\n\n');

  return new Response(`${body}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};

// Upstreams with a native `/responses/compact` (Azure, custom) answer with the
// non-streaming envelope directly; project it onto the SSE the target pipeline
// requires, leaving upstream error responses untouched so the boundary reports
// them verbatim.
export const nativeCompactToSse = async (call: Promise<ProviderCallResult>): Promise<ProviderCallResult> => {
  const result = await call;
  if (!result.response.ok) return result;
  return { response: compactionResultToSse((await result.response.json()) as ResponsesResult), modelKey: result.modelKey };
};
