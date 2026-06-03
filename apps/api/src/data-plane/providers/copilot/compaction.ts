import type { ResponsesCompactionItem, ResponsesCompactionTriggerItem, ResponsesInputItem, ResponsesInputMessage, ResponsesOutputItem, ResponsesResult } from '@floway-dev/protocols/responses';

// Copilot has no native `/responses/compact`, so we replicate codex's
// RemoteCompactionV2: drive a normal `/responses` turn with a trailing
// `compaction_trigger` input item, keep the single `compaction` output item the
// server returns, and rebuild the `response.compaction` envelope client-side.
// Retained-message reconstruction mirrors codex `build_v2_compacted_history`
// so the result matches a native Azure `/responses/compact` answer: the retained
// user/developer/system messages first, the compaction item last, ready for the
// client to resend `output` verbatim as the next turn's `input`.
// Reference (codex @ ebb79803697acee75baf24073ef49af87ad7e483):
//   codex-rs/core/src/compact_remote_v2.rs#L409-L457
export const COMPACTION_TRIGGER: ResponsesCompactionTriggerItem = { type: 'compaction_trigger' };

// codex's retained-message budget (its comment notes it mirrors the server-side
// `/responses/compact` default) and its token heuristic `ceil(utf8_bytes / 4)`,
// with images costing nothing. codex-rs/utils/string/src/truncate.rs#L71-L74.
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;
const RETAINED_ROLES: ReadonlySet<string> = new Set(['user', 'developer', 'system']);

const encoder = new TextEncoder();
const approxTokenCount = (text: string): number => Math.ceil(encoder.encode(text).length / APPROX_BYTES_PER_TOKEN);

const messageTokenCount = (message: ResponsesInputMessage): number =>
  typeof message.content === 'string'
    ? approxTokenCount(message.content)
    : message.content.reduce((sum, part) => (part.type === 'input_image' ? sum : sum + approxTokenCount(part.text)), 0);

const isRetainedMessage = (item: ResponsesInputItem): item is ResponsesInputMessage => item.type === 'message' && RETAINED_ROLES.has(item.role);

// Newest-first within the token budget, then restored to chronological order.
// codex additionally middle-truncates the single boundary message; we keep
// whole-message granularity and drop it instead — the partial-truncation marker
// is a codex display artifact, and the 64k/byte-4 figure only approximates the
// server cutoff in the first place.
const retainedMessages = (input: ResponsesInputItem[]): ResponsesInputMessage[] => {
  const messages = input.filter(isRetainedMessage);
  const kept: ResponsesInputMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    used += Math.max(messageTokenCount(messages[i]), 1);
    if (used > RETAINED_MESSAGE_TOKEN_BUDGET && kept.length > 0) break;
    kept.push(messages[i]);
  }
  return kept.reverse();
};

const compactionItem = (generated: ResponsesResult): ResponsesCompactionItem => {
  // The trigger turn may also emit a stray assistant message; codex ignores
  // everything but the lone compaction item and errors if it is not exactly one.
  const items = generated.output.filter((item): item is ResponsesCompactionItem => item.type === 'compaction');
  if (items.length !== 1) throw new Error(`Expected exactly one compaction output item from the Copilot trigger turn, got ${items.length}`);
  return items[0];
};

// Render a retained input message in the shape a native `/responses/compact`
// echoes: an id (so the store can mint a stored id and persist it), an explicit
// `status`, and array content. The client resends `output` verbatim as the next
// turn's `input`, so the items must be self-contained.
//
// A message the client sent without an id gets a synthetic one. Unlike the
// native path — where retained ids are the upstream's own echoed ids — these
// persist as upstream-owned with an id the upstream never issued, giving them
// `portable` affinity. That is benign: the compaction blob carries the real
// `forcing` affinity, and retained messages are resent as full content rather
// than `item_reference`s, so the synthetic id is never replayed to the upstream.
const retainedOutputMessage = (message: ResponsesInputMessage): ResponsesInputMessage => ({
  type: 'message',
  id: message.id ?? `msg_${crypto.randomUUID().replace(/-/g, '')}`,
  status: message.status ?? 'completed',
  role: message.role,
  content: typeof message.content === 'string' ? [{ type: 'input_text', text: message.content }] : message.content,
});

// The retained items are input-shaped messages (role:user, input_text content),
// which is what `/responses/compact` echoes so the client can resend `output`
// as the next turn's `input`. ResponsesOutputItem does not model a user-role
// message, so the cast records that the compaction envelope's output is
// deliberately input-shaped.
export const compactionResponse = (input: ResponsesInputItem[], generated: ResponsesResult): ResponsesResult => ({
  ...generated,
  object: 'response.compaction',
  output: [...retainedMessages(input).map(retainedOutputMessage), compactionItem(generated)] as unknown as ResponsesOutputItem[],
});
