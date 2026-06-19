import { onScopeDispose, ref, watch, type Ref } from 'vue';

// Synchronise a string ref with `location.hash` (without the leading `#`).
// The initial value is read on setup; subsequent assignments write through
// with `history.replaceState` so the browser does not scroll. An empty value
// drops the hash entirely. External hash changes (back/forward, pasted URL)
// propagate back into the ref via the `hashchange` event.
export const useHashRef = (): Ref<string | null> => {
  const readHash = () => {
    if (typeof location === 'undefined') return null;
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    return raw === '' ? null : raw;
  };

  const value = ref<string | null>(readHash());

  watch(value, next => {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    if (next === null) {
      if (location.hash === '') return;
      history.replaceState({}, '', `${location.pathname}${location.search}`);
      return;
    }
    const desired = `#${next}`;
    if (location.hash === desired) return;
    history.replaceState({}, '', desired);
  });

  const onHashChange = () => {
    const next = readHash();
    if (value.value !== next) value.value = next;
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', onHashChange);
    onScopeDispose(() => window.removeEventListener('hashchange', onHashChange));
  }

  return value;
};
