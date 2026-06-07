import { describe, expect, it, vi } from 'vitest';

import { runProxiedRequest } from './dialer.js';
import { ProxyDialError } from './errors.js';
import type { ProxyConfig } from './proxy-config.js';
import type { TargetSpec } from './types.js';

vi.mock('./protocols/http-connect.js', () => ({
  runHttpConnect: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/socks5.js', () => ({
  runSocks5: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/trojan.js', () => ({
  runTrojan: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/vless.js', () => ({
  runVlessTcpTls: vi.fn(async () => new Response('ok')),
  runVlessWsTls: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/shadowsocks.js', () => ({
  runShadowsocks: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/shadowsocks-2022.js', () => ({
  runShadowsocks2022: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/reality.js', () => ({
  runReality: vi.fn(async () => new Response('ok')),
}));

const target: TargetSpec = {
  dialHost: 'api.openai.com',
  port: 443,
  tls: true,
  method: 'GET',
  path: '/v1/models',
  headers: {},
};

const cases: Array<[ProxyConfig['kind'], ProxyConfig]> = [
  ['http', { kind: 'http', tls: false, host: 'h', port: 1, name: 'h' }],
  ['socks5', { kind: 'socks5', host: 'h', port: 1, name: 'h' }],
  ['trojan', { kind: 'trojan', password: 'p', host: 'h', port: 1, name: 'h' }],
  ['vless-tcp', { kind: 'vless-tcp', uuid: 'u', host: 'h', port: 1, name: 'h' }],
  ['vless-ws', { kind: 'vless-ws', uuid: 'u', host: 'h', port: 1, path: '/', name: 'h' }],
  ['ss', { kind: 'ss', method: 'aes-256-gcm', password: 'p', host: 'h', port: 1, name: 'h' }],
  ['ss2022', { kind: 'ss2022', method: '2022-blake3-aes-128-gcm', passwordBase64: 'a', host: 'h', port: 1, name: 'h' }],
  ['reality', { kind: 'reality', uuid: 'u', publicKey: 'p', fingerprint: 'chrome', serverName: 's', host: 'h', port: 1, name: 'h' }],
];

describe('runProxiedRequest dispatch', () => {
  it.each(cases)('routes kind=%s to its runner', async (_kind, config) => {
    const res = await runProxiedRequest(config, target);
    expect(await res.text()).toBe('ok');
  });
});

describe('runProxiedRequest deadline', () => {
  it('rejects with a tcp-connect ProxyDialError when the per-call timeout fires', async () => {
    // Wire socks5 to a runner that never resolves so only the deadline can
    // unstick the call. The dialer's combined controller signals abort
    // through to dispatch on timeout.
    const { runSocks5 } = await import('./protocols/socks5.js');
    vi.mocked(runSocks5).mockImplementationOnce(async opts => {
      // Hold open until the caller signal aborts; reject with the abort
      // reason so the dialer can surface the deadline error.
      await new Promise<void>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      return new Response();
    });
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      runProxiedRequest(config, target, { dialTimeoutMs: 50 }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('dial deadline exceeded'),
    });
  });

  it('rethrows the caller-driven AbortError when the external signal aborts mid-dial', async () => {
    const { runSocks5 } = await import('./protocols/socks5.js');
    vi.mocked(runSocks5).mockImplementationOnce(async opts => {
      await new Promise<void>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      return new Response();
    });
    const ac = new AbortController();
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    setTimeout(() => ac.abort(new DOMException('client gone', 'AbortError')), 30);
    await expect(
      runProxiedRequest(config, target, { signal: ac.signal, dialTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'client gone' });
  });

  it('refuses to dial when the caller signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new DOMException('already gone', 'AbortError'));
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      runProxiedRequest(config, target, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// `unused` is here to silence ProxyDialError-import-only lint noise.
void ProxyDialError;
