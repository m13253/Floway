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
  it('isolates a malformed proxy URL to upstreams that reference it', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // u_bad references the malformed row; u_ok shares the request but does
    // not. The whole-request build must still succeed; only u_bad's fetcher
    // surfaces the parse error, and only when actually called.
    await repo.upstreams.save(upstream('u_bad', ['p_bad']));
    await repo.upstreams.save(upstream('u_ok', []));
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', sortOrder: 0, dialTimeoutSeconds: null });

    const fetcherFor = await createPerRequestFetcher();
    const okFetcher = fetcherFor('u_ok');
    expect(typeof okFetcher).toBe('function');
    const badFetcher = fetcherFor('u_bad');
    await expect(badFetcher('https://example.com', { method: 'GET' }))
      .rejects.toThrow(/u_bad references malformed proxy p_bad/);
  });

  it('does not load the proxy catalog when no upstream references one', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // A malformed row sitting unreferenced in the table must not break
    // direct-only upstreams: we only parse rows that are reachable via some
    // upstream's fallback list.
    await repo.upstreams.save(upstream('u_direct', []));
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', sortOrder: 0, dialTimeoutSeconds: null });

    const fetcherFor = await createPerRequestFetcher();
    const directFetcher = fetcherFor('u_direct');
    expect(typeof directFetcher).toBe('function');
  });
});
