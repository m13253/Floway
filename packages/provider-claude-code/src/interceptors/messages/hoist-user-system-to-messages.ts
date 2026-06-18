import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import type { MessagesMessage, MessagesTextBlock } from '@floway-dev/protocols/messages';

// Synthetic assistant turn that closes the hoisted user/assistant pair so the
// upstream's role-alternation guard stays satisfied. The text is visible to
// the upstream and may echo back in completion text, so keep it minimal.
const SYNTHETIC_ACK = 'I will follow the above instructions.';

// On the re-mimicry path the upstream's `system` slot is reserved for the
// three CC-mimicry blocks (billing / identity / default template). Any
// caller-supplied system content must therefore move OUT of `system` before
// those three blocks are injected, otherwise the operator's instructions
// would be lost.
//
// The convention sub2api and Parrot both ship — and the one real CC clients
// fall back to when their own system text exceeds the bare identity block —
// is to fold the original system text into the head of `messages` as a
// synthetic user/assistant turn (user announces the system prompt, assistant
// acknowledges it). The acknowledgement keeps the conversation alternation
// valid: every following user message still sees an assistant turn behind it,
// so the upstream's role-alternation guard doesn't fire.
//
// Citations / cache_control on text blocks are dropped — the wrapped turn is
// best-effort recovery of the operator's intent; preserving cache scopes
// across this remix would only confuse the upstream's cache machinery,
// which is what the three CC blocks (with `cache_control` on system[2])
// already manage.
//
// References:
//   - https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_handler.go
//   - https://github.com/zinkawaii/Parrot/blob/master/src/transform/cc_mimicry.py
export const hoistUserSystemToMessages = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const captured = captureSystemText(ctx.payload.system);
  // inject-billing-block et al rebuild `system` from scratch as a three-block
  // array; removing the field here keeps the boundary mutation self-contained.
  const nextPayload = { ...ctx.payload };
  delete nextPayload.system;

  if (captured !== '') {
    const synthetic: MessagesMessage[] = [
      { role: 'user', content: `<system>\n${captured}\n</system>` },
      { role: 'assistant', content: SYNTHETIC_ACK },
    ];
    nextPayload.messages = [...synthetic, ...nextPayload.messages];
  }

  ctx.payload = nextPayload;
  return await run();
};

const captureSystemText = (system: string | MessagesTextBlock[] | undefined): string => {
  if (system === undefined) return '';
  if (typeof system === 'string') return system;
  return system
    .map(block => block.text)
    .filter(text => text.length > 0)
    .join('\n\n');
};
