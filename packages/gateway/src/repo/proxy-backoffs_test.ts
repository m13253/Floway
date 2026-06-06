import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';

describe('proxy_upstream_backoffs repo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const baseUnix = Math.floor(Date.UTC(2026, 5, 1) / 1000);

  it('records first failure with 60s expiry', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p', 'u', 'tcp refused');
    const rows = await repo.proxyBackoffs.listForUpstream('u');
    expect(rows).toEqual([
      {
        proxyId: 'p',
        upstreamId: 'u',
        failCount: 1,
        expiresAt: baseUnix + 60,
        lastError: 'tcp refused',
        lastErrorAt: baseUnix,
      },
    ]);
  });

  it('exponentially backs off and caps at 1h', async () => {
    const repo = new InMemoryRepo();
    const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
    for (let n = 0; n < expected.length; n++) {
      await repo.proxyBackoffs.recordDialFailure('p', 'u', `failure ${n + 1}`);
      const [row] = await repo.proxyBackoffs.listForUpstream('u');
      expect(row!.failCount).toBe(n + 1);
      expect(row!.expiresAt - baseUnix).toBe(expected[n]);
    }
  });

  it('clears the row on dial success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p', 'u', 'x');
    await repo.proxyBackoffs.recordDialSuccess('p', 'u');
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('isolates state between upstreams', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p', 'uA', 'x');
    expect(await repo.proxyBackoffs.listForUpstream('uB')).toEqual([]);
    expect(await repo.proxyBackoffs.listForUpstream('uA')).toHaveLength(1);
  });

  it('reset removes all rows for the proxy', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p', 'u1', 'x');
    await repo.proxyBackoffs.recordDialFailure('p', 'u2', 'x');
    await repo.proxyBackoffs.resetForProxy('p');
    expect(await repo.proxyBackoffs.listForProxy('p')).toEqual([]);
  });

  it('reset for a single (proxy, upstream)', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p', 'u1', 'x');
    await repo.proxyBackoffs.recordDialFailure('p', 'u2', 'x');
    await repo.proxyBackoffs.reset('p', 'u1');
    const ids = (await repo.proxyBackoffs.listForProxy('p')).map(r => r.upstreamId);
    expect(ids).toEqual(['u2']);
  });

  it('listAll returns every row', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('p1', 'u1', 'x');
    await repo.proxyBackoffs.recordDialFailure('p2', 'u2', 'x');
    expect(await repo.proxyBackoffs.listAll()).toHaveLength(2);
  });
});
