import { describe, expect, it, vi } from 'vitest';

import { dial, runProxiedRequest } from './dialer.ts';
import type { ProxyConfig } from './proxy-config.ts';
import type { DialOptions, DialResult, ProxyRequestTarget, SocketDial } from './types.ts';

const noopStream = (): DialResult => {
  const readable = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const writable = new WritableStream<Uint8Array>();
  return { readable, writable };
};

vi.mock('./protocols/http-connect.ts', () => ({
  dialHttpConnect: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/socks5.ts', () => ({
  dialSocks5: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/trojan.ts', () => ({
  dialTrojan: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/vless.ts', () => ({
  dialVlessTcpTls: vi.fn(async () => noopStream()),
  dialVlessWsTls: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/shadowsocks.ts', () => ({
  dialShadowsocks: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/shadowsocks-2022.ts', () => ({
  dialShadowsocks2022: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/reality.ts', () => ({
  dialReality: vi.fn(async () => noopStream()),
}));

const target: ProxyRequestTarget = {
  host: 'api.openai.com',
  port: 443,
  tls: true,
  alpn: undefined,
};

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub socket dial — tests should not reach here');
  },
};

const baseOptions = (): DialOptions => ({ socketDial: stubSocketDial });

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

describe('dial dispatch', () => {
  it.each(cases)('routes kind=%s to its dialer', async (_kind, config) => {
    const result = await dial(config, target, baseOptions());
    expect(result.readable).toBeInstanceOf(ReadableStream);
    expect(result.writable).toBeInstanceOf(WritableStream);
  });
});

describe('dial deadline', () => {
  it('rejects with a tcp-connect ProxyDialError when the per-call timeout fires', async () => {
    // Wire socks5 to a dialer that never resolves so only the deadline can
    // unstick the call. The dial wrapper's combined controller signals abort
    // through to dispatch on timeout.
    const { dialSocks5 } = await import('./protocols/socks5.ts');
    vi.mocked(dialSocks5).mockImplementationOnce(async (_c, _t, opts) => {
      // Hold open until the caller signal aborts; reject with the abort
      // reason so the dial wrapper can surface the deadline error.
      await new Promise<DialResult>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      dial(config, target, { ...baseOptions(), dialTimeoutMs: 50 }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('exceeded deadline'),
    });
  });

  it('rethrows the caller-driven AbortError when the external signal aborts mid-dial', async () => {
    const { dialSocks5 } = await import('./protocols/socks5.ts');
    vi.mocked(dialSocks5).mockImplementationOnce(async (_c, _t, opts) => {
      await new Promise<DialResult>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const ac = new AbortController();
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    setTimeout(() => ac.abort(new DOMException('client gone', 'AbortError')), 30);
    await expect(
      dial(config, target, { ...baseOptions(), signal: ac.signal, dialTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'client gone' });
  });

  it('refuses to dial when the caller signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new DOMException('already gone', 'AbortError'));
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      dial(config, target, { ...baseOptions(), signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runProxiedRequest — post-dial teardown', () => {
  it('cancels the dialed readable when the inner-TLS step throws past the dial', async () => {
    // Track every cancel attempt directly on the readable so the assertion
    // doesn't depend on cancel-hook semantics (the hook doesn't fire once
    // the underlying source is already done/errored, which userspaceTls's
    // pump leaves the EOFed source in by the time the catch runs).
    let cancelCalls = 0;
    let lastCancelReason: unknown = undefined;
    const { dialSocks5 } = await import('./protocols/socks5.ts');
    vi.mocked(dialSocks5).mockImplementationOnce(async () => {
      const inner = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      const readable = new Proxy(inner, {
        get(t, prop, recv) {
          if (prop === 'cancel') {
            return (reason: unknown) => {
              cancelCalls++;
              lastCancelReason = reason;
              return Reflect.get(t, prop, recv).call(t, reason);
            };
          }
          return Reflect.get(t, prop, recv);
        },
      });
      const writable = new WritableStream<Uint8Array>();
      return { readable, writable };
    });
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      runProxiedRequest(config, target, { method: 'GET', path: '/', headers: {} }, baseOptions()),
    ).rejects.toBeInstanceOf(Error);
    expect(cancelCalls).toBeGreaterThan(0);
    expect((lastCancelReason as Error)?.message ?? '').toMatch(/.+/);
  });
});
