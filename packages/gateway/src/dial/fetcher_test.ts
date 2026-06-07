import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetcher, type ProxyEntry } from './fetcher.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { ProxyDialError, type ProxyConfig, type TargetSpec } from '@floway-dev/proxy';

describe('createFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const proxyA: ProxyEntry = { config: { kind: 'socks5', host: 'a', port: 1, name: 'a' }, dialTimeoutMs: null };
  const proxyB: ProxyEntry = { config: { kind: 'socks5', host: 'b', port: 1, name: 'b' }, dialTimeoutMs: null };

  it('first-pass tries each non-backoff entry in order and short-circuits on success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const calls: string[] = [];
    const fetcher = createFetcher({
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

  it('records exactly one dial failure per call when the same entry is the only fallback', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('boom', 'tcp-connect'); },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    // Pass-2 only walks entries pass-1 skipped (i.e. ones in active backoff).
    // A fresh entry that fails pass-1 stays out of pass-2, so we record one
    // failure per real failure — preserving the geometric backoff schedule.
    expect(row!.failCount).toBe(1);
  });

  it('clears backoff on dial success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const fetcher = createFetcher({
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
    const fetcher = createFetcher({
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

  it('does not retry an entry that already failed in the first pass', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a', 'b'],
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        throw new ProxyDialError('fail', 'tcp-connect');
      },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['a', 'b']);
    // Each entry recorded one failure, not two.
    const rows = await repo.proxyBackoffs.listForUpstream('u');
    expect(rows.map(r => [r.proxyId, r.failCount]).sort()).toEqual([['a', 1], ['b', 1]]);
  });

  it('non-ProxyDialError errors propagate immediately and do not update backoff', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
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
    const fetcher = createFetcher({
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
    const fetcher = createFetcher({
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

  it('rethrows AbortError without continuing the chain', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['direct', 'a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(`proxy:${config.host}`);
        return new Response('proxy-should-not-be-called');
      },
      runDirect: async () => {
        calls.push('direct');
        throw new DOMException('client gone', 'AbortError');
      },
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['direct']);
    // No proxy was attempted, so backoff stays empty.
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('forwards init.signal to runProxied so the dialer can honour client cancellation', async () => {
    const repo = new InMemoryRepo();
    let observedSignal: AbortSignal | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_c, _t, options) => {
        observedSignal = options?.signal;
        return new Response('ok');
      },
      runDirect: async () => new Response('direct'),
    });
    const ac = new AbortController();
    await fetcher('https://api.openai.com', { method: 'GET', signal: ac.signal });
    expect(observedSignal).toBe(ac.signal);
  });

  it('captures the runtime-synthesized multipart Content-Type when posting FormData', async () => {
    const repo = new InMemoryRepo();
    const captured: TargetSpec[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, target) => { captured.push(target); return new Response('ok'); },
      runDirect: async () => new Response('direct'),
    });
    const fd = new FormData();
    fd.append('field', 'value');
    await fetcher('https://api.openai.com/v1/upload', { method: 'POST', body: fd });
    expect(captured).toHaveLength(1);
    const contentType = captured[0]!.headers['content-type'];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('lets the caller override the FormData-synthesized Content-Type', async () => {
    const repo = new InMemoryRepo();
    const captured: TargetSpec[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, target) => { captured.push(target); return new Response('ok'); },
      runDirect: async () => new Response('direct'),
    });
    const fd = new FormData();
    fd.append('field', 'value');
    await fetcher('https://api.openai.com/v1/upload', {
      method: 'POST',
      body: fd,
      headers: { 'Content-Type': 'application/x-explicit-override' },
    });
    expect(captured[0]!.headers['content-type']).toBe('application/x-explicit-override');
  });

  it('rejects ReadableStream bodies upfront', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirect: async () => new Response('direct'),
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'));
        controller.close();
      },
    });
    await expect(fetcher('https://api.openai.com/v1/x', { method: 'POST', body: stream }))
      .rejects.toThrow(/streaming request bodies/);
  });

  it('persists the failed dial stage in the backoff lastError tag', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: ['a'],
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('cert mismatch', 'inner-tls'); },
      runDirect: async () => new Response('ok'),
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    expect(row!.lastError).toBe('[inner-tls] cert mismatch');
  });
});
