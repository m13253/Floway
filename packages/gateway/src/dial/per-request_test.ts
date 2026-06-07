import { describe, expect, it } from 'vitest';

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
  it('throws when a referenced proxy row carries a malformed URL', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // The dashboard validates URLs at POST/PATCH time, so a malformed row in
    // the proxies table is operator-actionable D1 drift. Surface the parse
    // error rather than silently dropping the proxy.
    await repo.upstreams.save(upstream('u_ok', ['p_bad']));
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', sortOrder: 0 });

    await expect(createPerRequestFetcher()).rejects.toThrow();
  });

  it('does not load the proxy catalog when no upstream references one', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // A malformed row sitting unreferenced in the table must not break
    // direct-only upstreams: we only parse rows that are reachable via some
    // upstream's fallback list.
    await repo.upstreams.save(upstream('u_direct', []));
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', sortOrder: 0 });

    const fetcherFor = await createPerRequestFetcher();
    const directFetcher = fetcherFor('u_direct');
    expect(typeof directFetcher).toBe('function');
  });
});
