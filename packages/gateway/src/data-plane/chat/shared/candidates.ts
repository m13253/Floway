import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

// Re-exported here so chat call sites do not have to know that the
// underlying type lives in `@floway-dev/provider`.
export type { ProviderCandidate };

// Maps each chat target protocol to the `ModelEndpoints` flag the catalog
// uses to advertise it. The two names differ for `chat-completions` /
// `chatCompletions`; otherwise the mapping is identity.
const ENDPOINT_FOR_CHAT_TARGET: Record<ChatTargetApi, keyof ModelEndpoints> = {
  messages: 'messages',
  responses: 'responses',
  'chat-completions': 'chatCompletions',
};

// A chat-target preference list paired with the two queries the serve and
// attempt layers ask of it:
//
// - `canServe(endpoints)`: does the candidate expose any target this
//   serve is willing to dispatch on? The serve layer uses this to drop
//   non-viable candidates before they reach the planner.
// - `pick(endpoints)`: the first viable target in preference order. The
//   serve has already filtered, so `pick` is contractually total — it
//   throws on a non-viable candidate rather than returning `null`, so
//   downstream code never carries a `ChatTargetApi | null` plumbing.
export interface ChatTargetPicker {
  readonly canServe: (endpoints: ModelEndpoints) => boolean;
  readonly pick: (endpoints: ModelEndpoints) => ChatTargetApi;
}

export const chatTargetPicker = (preference: readonly ChatTargetApi[]): ChatTargetPicker => {
  const find = (endpoints: ModelEndpoints): ChatTargetApi | null => {
    for (const target of preference) {
      if (endpoints[ENDPOINT_FOR_CHAT_TARGET[target]] !== undefined) return target;
    }
    return null;
  };
  return {
    canServe: e => find(e) !== null,
    pick: e => {
      const t = find(e);
      if (t === null) throw new Error('chatTargetPicker.pick: serve passed a non-viable candidate; the serve must filter with canServe before dispatch');
      return t;
    },
  };
};
