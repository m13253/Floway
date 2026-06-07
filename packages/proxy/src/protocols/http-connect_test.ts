import { describe, expect, it } from 'vitest';

import { ProxyDialError } from '../errors.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';
import type { DialOptions, DialTarget } from '../types.ts';
import { dialHttpConnect } from './http-connect.ts';
import type { HttpProxyConfig } from '../proxy-config.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const httpConfig = (overrides: Partial<HttpProxyConfig> = {}): HttpProxyConfig => ({
  kind: 'http',
  tls: false,
  host: 'proxy.example',
  port: 3128,
  name: 'p',
  ...overrides,
});

describe('dialHttpConnect — request line', () => {
  it('emits CONNECT host:port HTTP/1.1 with a Host header that matches the authority', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialHttpConnect(httpConfig(), target, opts);
    const srv = await fake.awaitConnect();

    // We don't pre-assume how many bytes the dialer batches; pull until the
    // double-CRLF terminator and decode in one shot.
    const decoder = new TextDecoder();
    let head = '';
    while (!head.includes('\r\n\r\n')) {
      const chunk = await srv.read(1);
      head += decoder.decode(chunk, { stream: true });
    }
    expect(head).toContain('CONNECT api.openai.com:443 HTTP/1.1\r\n');
    expect(head).toContain('Host: api.openai.com:443\r\n');
    expect(head).not.toContain('Proxy-Authorization');

    srv.respond('HTTP/1.1 200 Connection Established\r\n\r\n');
    await promise;
  });

  it('embeds Proxy-Authorization: Basic <base64> when credentials are configured', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialHttpConnect(
      httpConfig({ username: 'aladdin', password: 'open sesame' }),
      target,
      opts,
    );
    const srv = await fake.awaitConnect();

    const decoder = new TextDecoder();
    let head = '';
    while (!head.includes('\r\n\r\n')) {
      head += decoder.decode(await srv.read(1), { stream: true });
    }
    // RFC 7617 Basic-auth canonical example.
    expect(head).toContain('Proxy-Authorization: Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ==\r\n');

    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });
});

describe('dialHttpConnect — happy path body forwarding', () => {
  it('returns a stream whose readable carries post-handshake bytes', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    // Drain the request head.
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) {
      await srv.read(1);
    }
    while (srv.peekWritten().byteLength) await srv.read(srv.peekWritten().byteLength);

    // Server response includes 4 bytes of post-handshake payload riding in
    // the same TCP segment as the CONNECT 200.
    srv.respond('HTTP/1.1 200 Connection Established\r\n\r\nDATA');
    const result = await promise;

    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toBe('DATA');

    srv.respond('MORE');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value!)).toBe('MORE');

    srv.endResponse();
    const eof = await reader.read();
    expect(eof.done).toBe(true);
  });
});

describe('dialHttpConnect — failure modes', () => {
  it('classifies tcp-connect failures with the underlying cause', async () => {
    const fake = makeFakeSocketDial();
    fake.failNextConnect(new Error('ECONNREFUSED'));
    await expect(
      dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('tcp connect to proxy.example:3128 failed'),
    });
  });

  it('surfaces 407 Proxy Authentication Required as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.respond('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
    const result = await promise;
    // The CONNECT error rides through the post-CONNECT readable as an error
    // — assert on the readable rather than the dial promise (the dial
    // resolves once the CONNECT request is sent; the error surfaces when
    // the orchestrator's next consumer pulls).
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('407'),
    });
  });

  it('surfaces 502 Bad Gateway as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const result = await (async () => {
      const p = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);
      srv.respond('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return await p;
    })();
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('502'),
    });
  });

  it('rejects malformed status lines as proxy-handshake', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.respond('NOT-HTTP whatsoever\r\n\r\n');
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('bad status line'),
    });
  });

  it('caps the header buffer so a hostile proxy with no terminator cannot OOM the dialer', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    // 70 KiB of garbage with NO double-CRLF.
    const garbage = new Uint8Array(70 * 1024);
    garbage.fill(0x41);
    srv.respond(garbage);
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/exceeded.*without a header terminator/),
    });
  });

  it('reports proxy-handshake when the server hangs up before any status', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.endResponse();
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toBeInstanceOf(ProxyDialError);
  });
});
