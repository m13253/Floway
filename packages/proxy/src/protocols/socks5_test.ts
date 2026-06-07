import { describe, expect, it } from 'vitest';

import type { Socks5ProxyConfig } from '../proxy-config.ts';
import { dialSocks5 } from './socks5.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';
import type { DialOptions, DialTarget } from '../types.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const socks5Config = (overrides: Partial<Socks5ProxyConfig> = {}): Socks5ProxyConfig => ({
  kind: 'socks5',
  host: 'proxy.example',
  port: 1080,
  name: 'p',
  ...overrides,
});

const arr = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

const expectEqualBytes = (got: Uint8Array, want: number[]): void => {
  expect(Array.from(got)).toEqual(want);
};

describe('dialSocks5 — RFC 1928 no-auth happy path', () => {
  it('writes greeting [0x05 0x01 0x00] and a domain-typed CONNECT request', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialSocks5(socks5Config(), target, opts);
    const srv = await fake.awaitConnect();

    // 1) Greeting: VER=0x05, NMETHODS=0x01, METHOD=0x00 (no-auth).
    expectEqualBytes(await srv.read(3), [0x05, 0x01, 0x00]);
    srv.respond(arr(0x05, 0x00));

    // 2) CONNECT request:
    //    VER=0x05, CMD=0x01, RSV=0x00, ATYP=0x03,
    //    DOM_LEN=14, DOM='api.openai.com', PORT=0x01bb (443).
    const head = await srv.read(4);
    expectEqualBytes(head, [0x05, 0x01, 0x00, 0x03]);
    const lenBuf = await srv.read(1);
    expect(lenBuf[0]).toBe('api.openai.com'.length);
    const dom = await srv.read(lenBuf[0]!);
    expect(new TextDecoder().decode(dom)).toBe('api.openai.com');
    const port = await srv.read(2);
    expectEqualBytes(port, [0x01, 0xbb]);

    // 3) Reply: success with IPv4 BND.ADDR.
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00));

    const result = await promise;
    expect(result.readable).toBeInstanceOf(ReadableStream);

    // 4) Post-handshake bytes flow through transparently.
    srv.respond(arr(0xde, 0xad, 0xbe, 0xef));
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expectEqualBytes(value!, [0xde, 0xad, 0xbe, 0xef]);
  });
});

describe('dialSocks5 — RFC 1929 user/pass sub-negotiation', () => {
  it('offers methods 0x00 and 0x02, then runs the user/pass sub-negotiation when selected', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'user', password: 'pass' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();

    // Greeting offers no-auth + user/pass.
    expectEqualBytes(await srv.read(4), [0x05, 0x02, 0x00, 0x02]);
    // Server picks user/pass.
    srv.respond(arr(0x05, 0x02));

    // RFC 1929 sub-negotiation: VER=0x01, ULEN=4, 'user', PLEN=4, 'pass'.
    const subNeg = await srv.read(1 + 1 + 4 + 1 + 4);
    expectEqualBytes(subNeg, [
      0x01,
      0x04, ...new TextEncoder().encode('user'),
      0x04, ...new TextEncoder().encode('pass'),
    ]);
    srv.respond(arr(0x01, 0x00));

    // CONNECT request follows the same shape.
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });

  it('rejects auth failure (status != 0x00) as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4); // greeting
    srv.respond(arr(0x05, 0x02));
    await srv.read(1 + 1 + 1 + 1 + 1); // sub-neg
    srv.respond(arr(0x01, 0x01)); // status=1 → failure

    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('auth failed'),
    });
  });

  it('rejects username longer than 255 bytes before any I/O', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u'.repeat(256), password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    // Server must accept the greeting and pick user/pass for the dialer to
    // even get to the cred-too-long check.
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      message: expect.stringContaining('cred too long'),
    });
  });
});

describe('dialSocks5 — failure modes', () => {
  it('rejects an "no acceptable methods" reply (0x05 0xff)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0xff));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('no acceptable methods'),
    });
  });

  it('rejects a connection-refused CONNECT reply with the upstream rep code in the message', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);

    // rep=0x05 → connection refused (RFC 1928 §6).
    srv.respond(arr(0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('status=5'),
    });
  });

  it('handles ATYP=0x04 (IPv6) in the CONNECT reply by reading the 16-byte BND.ADDR', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);

    const ipv6 = new Uint8Array(16);
    const port = arr(0x00, 0x00);
    const reply = new Uint8Array([0x05, 0x00, 0x00, 0x04, ...ipv6, ...port]);
    srv.respond(reply);
    await promise;
  });

  it('rejects an unknown ATYP in the CONNECT reply', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);

    srv.respond(arr(0x05, 0x00, 0x00, 0x77));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unknown ATYP'),
    });
  });
});
