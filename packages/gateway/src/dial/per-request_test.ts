import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPerRequestFetcher } from './per-request.ts';
import { initRepo } from '../repo/index.ts';
import { InMemoryRepo } from '../repo/memory.ts';

const COPILOT_CONFIG = {
  githubToken: 'tok',
  accountType: 'individual' as const,
  user: { login: 'u', avatar_url: '', name: null, id: 1 },
};

const upstream = (id: string, proxyFallbackList: string[]) => ({
  id,
  provider: 'copilot' as const,
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList,
  config: COPILOT_CONFIG,
  state: null,
});

describe('createPerRequestFetcher', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('skips a malformed proxy url and still serves direct-only upstreams', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // u_ok references a proxy with a malformed URL — its dial path will be
    // broken, but u_direct must still get a working fetcher.
    await repo.upstreams.save(upstream('u_ok', ['p_bad']));
    await repo.upstreams.save(upstream('u_direct', []));
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', sortOrder: 0 });

    const fetcherFor = await createPerRequestFetcher();
    expect(consoleError).toHaveBeenCalled();
    expect(consoleError.mock.calls[0]![0]).toMatch(/proxy p_bad: skipping/);

    // u_direct's fetcher walks the implicit ['direct'] list and never asks
    // for the proxy table, so it works regardless of the malformed entry.
    const directFetcher = fetcherFor('u_direct');
    expect(typeof directFetcher).toBe('function');
  });
});
