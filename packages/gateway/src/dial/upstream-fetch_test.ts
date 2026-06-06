import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUpstreamFetch } from './upstream-fetch.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { ProxyDialError, type ProxyConfig, type TargetSpec } from '@floway-dev/proxy';

describe('createUpstreamFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const proxyA: ProxyConfig = { kind: 'socks5', host: 'a', port: 1, name: 'a' };
  const proxyB: ProxyConfig = { kind: 'socks5', host: 'b', port: 1, name: 'b' };

  it('first-pass tries each non-backoff entry in order and short-circuits on success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const calls: string[] = [];
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a', 'b', 'direct'],
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig, _target: TargetSpec) => {
        calls.push(config.host);
        return new Response('ok');
      },
      runDirect: async () => {
        calls.push('direct');
        return new Response('direct');
      },
    });
    const res = await fetcher('https://api.openai.com/v1/models', { method: 'GET' });
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['b']);
  });

  it('records dial failures', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('boom', 'tcp-connect'); },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    // first pass + second pass = 2 increments
    expect(row!.failCount).toBe(2);
  });

  it('clears backoff on dial success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirect: async () => new Response('ok'),
    });
    // first-pass skips a (in backoff). second-pass ignores backoff and succeeds.
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('falls through to second pass when first pass exhausts', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    await repo.proxyBackoffs.recordDialFailure('b', 'u', 'x');
    const order: string[] = [];
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a', 'b'],
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        order.push(config.host);
        if (order.length < 2) throw new ProxyDialError('still bad', 'tcp-connect');
        return new Response('ok');
      },
      runDirect: async () => new Response('ok'),
    });
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(order).toEqual(['a', 'b']);
  });

  it('non-ProxyDialError errors propagate immediately and do not update backoff', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new Error('upstream 500'); },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toThrow('upstream 500');
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('empty fallback list defaults to ["direct"]', async () => {
    const repo = new InMemoryRepo();
    let directCalled = false;
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: [],
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirect: async () => { directCalled = true; return new Response('direct'); },
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(directCalled).toBe(true);
    expect(await res.text()).toBe('direct');
  });

  it('aggregates errors when both passes exhaust with multiple entries failing', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createUpstreamFetch({
      repo,
      upstreamId: 'u',
      fallbackList: ['a', 'b'],
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async () => { throw new ProxyDialError('fail', 'tcp-connect'); },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' }))
      .rejects.toBeInstanceOf(AggregateError);
  });
});
