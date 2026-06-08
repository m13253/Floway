import { describe, expect, it } from 'vitest';

import { HttpProtocolError } from './errors.ts';
import { fetchOnStream, parseHttpResponse } from './fetch-on-stream.ts';
import { collectBody, makeFakeDuplex } from './test-utils.ts';

const decodeAscii = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('parseHttpResponse — status line', () => {
  it.each([
    ['HTTP/1.1 200 OK', 200],
    ['HTTP/1.1 404 Not Found', 404],
    ['HTTP/1.0 503 Service Unavailable', 503],
    // RFC 9112 §4 + erratum 4087: reason-phrase may be empty, but the
    // second SP separator is mandatory.
    ['HTTP/1.1 200 ', 200],
  ])('parses %s as status %d', async (line, status) => {
    const fake = makeFakeDuplex();
    fake.respond(`${line}\r\nContent-Length: 0\r\n\r\n`);
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(resp.status).toBe(status);
  });

  it('rejects a status line missing the second SP separator', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects malformed status lines as HttpProtocolError', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/2 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toBeInstanceOf(HttpProtocolError);
  });

  it('rejects an EOF before the headers terminator', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length:');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('EOF before headers'),
    });
  });

  it('caps the header buffer at 64 KiB to defend against unbounded headers', async () => {
    const fake = makeFakeDuplex();
    // 70 KiB of plausible-looking but never-terminating header bytes.
    fake.respond('HTTP/1.1 200 OK\r\n');
    const garbage = `X-Garbage: ${  'a'.repeat(70 * 1024)}`;
    fake.respond(garbage);
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringMatching(/exceeded.*without a terminator/),
    });
  });
});

describe('parseHttpResponse — smuggling defenses', () => {
  it('rejects two distinct Content-Length headers', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringMatching(/Content-Length headers/),
    });
  });

  it('rejects messages that carry both Transfer-Encoding and Content-Length (TE+CL smuggling)', async () => {
    const fake = makeFakeDuplex();
    fake.respond([
      'HTTP/1.1 200 OK',
      'Transfer-Encoding: chunked',
      'Content-Length: 5',
      '',
      '5\r\nhello\r\n0\r\n\r\n',
    ].join('\r\n'));
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('both Transfer-Encoding and Content-Length'),
    });
  });

  it('rejects Transfer-Encoding values that do not end in chunked', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('without chunked'),
    });
  });

  it('rejects Transfer-Encoding that lists chunked twice', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, chunked\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('chunked listed more than once'),
    });
  });

  it('rejects a Content-Length with non-digit characters', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5 garbage\r\n\r\nhello');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('malformed Content-Length'),
    });
  });

  it('rejects a negative Content-Length', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toBeInstanceOf(HttpProtocolError);
  });
});

describe('parseHttpResponse — body framing modes', () => {
  it('uses Content-Length framing when present', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello');
  });

  it('uses chunked framing when Transfer-Encoding ends in chunked', async () => {
    const fake = makeFakeDuplex();
    fake.respond([
      'HTTP/1.1 200 OK',
      'Transfer-Encoding: chunked',
      '',
      '5\r\nhello\r\n0\r\n\r\n',
    ].join('\r\n'));
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello');
    // The internal transfer-encoding header is stripped because it has been
    // decoded — re-exposing it would mislead downstream consumers.
    expect(resp.headers.get('transfer-encoding')).toBeNull();
  });

  it('falls back to read-until-EOF when neither CL nor TE is present (HTTP/1.0 style)', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.0 200 OK\r\n\r\nhello world');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('errors the body when the upstream EOFs before Content-Length is satisfied', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(resp.arrayBuffer()).rejects.toMatchObject({
      name: 'HttpProtocolError',
      message: expect.stringContaining('upstream EOF after 5/10'),
    });
  });
});

describe('fetchOnStream — request line and headers', () => {
  it('emits a canonical request line, drops caller framing headers, and adds Connection: close', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'POST',
        path: '/v1/messages?stream=true',
        headers: {
          Host: 'api.openai.com',
          Authorization: 'Bearer xxx',
          // These three are stripped by fetchOnStream — the buffered body
          // length is the source of truth.
          'Content-Length': '999',
          'Transfer-Encoding': 'chunked',
          Connection: 'keep-alive',
        },
        body: new TextEncoder().encode('payload'),
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;

    const head = decodeAscii(fake.written());
    expect(head).toMatch(/^POST \/v1\/messages\?stream=true HTTP\/1\.1\r\n/);
    expect(head).toContain('Host: api.openai.com\r\n');
    expect(head).toContain('Authorization: Bearer xxx\r\n');
    expect(head).toContain('Content-Length: 7\r\n');
    expect(head).not.toMatch(/Content-Length: 999/);
    expect(head).not.toMatch(/Transfer-Encoding/i);
    // Connection MUST be normalised to 'close'; gateway is one-shot.
    expect(head).toContain('Connection: close\r\n');
    // Strict identity encoding so the wire isn't double-decoded by us.
    expect(head).toContain('Accept-Encoding: identity\r\n');
    // Body rides after the head.
    expect(head).toMatch(/\r\n\r\npayload$/);
  });

  it('does not set Content-Length when there is no body', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).not.toMatch(/Content-Length:/i);
  });

  it('coalesces an opt.prefix into the same write as the request head', async () => {
    const fake = makeFakeDuplex();
    let firstChunk: Uint8Array | null = null;
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        firstChunk ??= new Uint8Array(chunk);
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
      { prefix: new TextEncoder().encode('PREFIX-BYTES') },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;

    expect(firstChunk).not.toBeNull();
    const text = decodeAscii(firstChunk!);
    expect(text.startsWith('PREFIX-BYTESGET / HTTP/1.1\r\n')).toBe(true);
  });
});

describe('fetchOnStream — body-bearing responses', () => {
  it('returns a chunked body whose chunks decode losslessly', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond([
      'HTTP/1.1 200 OK',
      'Content-Type: text/plain',
      'Transfer-Encoding: chunked',
      '',
      // Three chunks: "Wiki", "pedia", " in chunks."
      '4\r\nWiki\r\n5\r\npedia\r\nB\r\n in chunks.\r\n0\r\n\r\n',
    ].join('\r\n'));
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('Wikipedia in chunks.');
  });

  it('returns a Content-Length body whose bytes match exactly', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world');
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('reads to EOF when the response carries neither CL nor TE', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.0 200 OK\r\n\r\nhello there');
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('hello there');
  });
});
