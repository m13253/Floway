import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

import { useHashRef } from './useHashRef.ts';

interface HistoryStub {
  replaceState: ReturnType<typeof vi.fn>;
}

interface WindowStub {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface DomStubs {
  location: { hash: string; pathname: string; search: string };
  history: HistoryStub;
  window: WindowStub;
}

const installDom = (initialHash: string): DomStubs => {
  const stubs: DomStubs = {
    location: { hash: initialHash, pathname: '/dashboard/keys/x/requests', search: '' },
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        // Mirror the browser's behaviour: replaceState updates location to the
        // resolved URL. Tests only care about hash + the optional drop case.
        const hashIdx = url.indexOf('#');
        stubs.location.hash = hashIdx === -1 ? '' : url.slice(hashIdx);
      }),
    },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
  vi.stubGlobal('location', stubs.location);
  vi.stubGlobal('history', stubs.history);
  vi.stubGlobal('window', stubs.window);
  return stubs;
};

let scope: ReturnType<typeof effectScope> | null = null;

beforeEach(() => {
  scope = effectScope();
});

afterEach(() => {
  scope?.stop();
  scope = null;
  vi.unstubAllGlobals();
});

const runInScope = <T>(fn: () => T): T => {
  const result = scope!.run(fn);
  if (result === undefined) throw new Error('scope returned undefined');
  return result;
};

test('seeds value from existing location.hash on mount', async () => {
  installDom('#rec_abc');
  const value = runInScope(() => useHashRef());
  await nextTick();
  expect(value.value).toBe('rec_abc');
});

test('treats empty hash as null', async () => {
  installDom('');
  const value = runInScope(() => useHashRef());
  await nextTick();
  expect(value.value).toBeNull();
});

test('writes hash via history.replaceState (no scroll) when value changes', async () => {
  const dom = installDom('');
  const value = runInScope(() => useHashRef());
  await nextTick();
  value.value = 'rec_xyz';
  await nextTick();
  expect(dom.history.replaceState).toHaveBeenCalledWith({}, '', '#rec_xyz');
});

test('drops the hash entirely when value becomes null', async () => {
  const dom = installDom('#rec_xyz');
  const value = runInScope(() => useHashRef());
  await nextTick();
  value.value = null;
  await nextTick();
  expect(dom.history.replaceState).toHaveBeenCalledWith({}, '', '/dashboard/keys/x/requests');
});

test('listens for hashchange and updates the ref reactively', async () => {
  const dom = installDom('#rec_one');
  const value = runInScope(() => useHashRef());
  await nextTick();
  expect(value.value).toBe('rec_one');

  const [, handler] = dom.window.addEventListener.mock.calls.find(
    ([type]) => type === 'hashchange',
  )!;
  dom.location.hash = '#rec_two';
  (handler as () => void)();
  expect(value.value).toBe('rec_two');
});

test('removes the hashchange listener on scope dispose', async () => {
  const dom = installDom('');
  runInScope(() => useHashRef());
  await nextTick();
  const added = dom.window.addEventListener.mock.calls.find(([t]) => t === 'hashchange');
  scope!.stop();
  scope = null;
  const removed = dom.window.removeEventListener.mock.calls.find(([t]) => t === 'hashchange');
  expect(removed?.[1]).toBe(added?.[1]);
});

test('does not loop when hashchange echoes the current value', async () => {
  const dom = installDom('#rec_one');
  runInScope(() => useHashRef());
  await nextTick();
  dom.history.replaceState.mockClear();
  const [, handler] = dom.window.addEventListener.mock.calls.find(
    ([type]) => type === 'hashchange',
  )!;
  (handler as () => void)();
  await nextTick();
  expect(dom.history.replaceState).not.toHaveBeenCalled();
});
