import { describe, expect, it } from 'vitest';

import { HttpProtocolError } from './errors.ts';
import { fetchOnStream } from './fetch-on-stream.ts';
import { parseHttpResponse } from './parser.ts';
import { collectBody, collectBodyBytes, makeFakeDuplex, respondAndEnd } from './test-utils.ts';

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
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
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

describe('parseHttpResponse — Content-Length / Transfer-Encoding smuggling matrix', () => {
  // RFC 9112 §6.3: the Content-Length and Transfer-Encoding combinations
  // below are exactly the smuggling-shaped messages a request smuggler
  // exploits to desync front-end and back-end framing.

  it('rejects CL+TE with the CL listed first', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'CL_AND_TE' });
  });

  it('rejects CL+TE with the TE listed first', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'CL_AND_TE' });
  });

  it('rejects two Content-Length headers carrying the same numeric value', async () => {
    // RFC 9112 §6.3 allows CL repeated with the same value to be folded
    // into one — but this layer rejects all duplicates outright as the
    // safer policy against smuggling proxies that disagree about folding.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello',
    ))).rejects.toMatchObject({ code: 'MULTIPLE_CL' });
  });

  it('rejects two Content-Length headers carrying different numeric values', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 10\r\n\r\nhellohello',
    ))).rejects.toMatchObject({ code: 'MULTIPLE_CL' });
  });

  it('rejects a comma-separated dual Content-Length within a single header', async () => {
    // The Headers map will append-fold "5,5" but the parser stores raw
    // values per occurrence; both forms must be rejected.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello',
    ))).rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Transfer-Encoding: gzip alone (we do not honor non-chunked TE)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('rejects Transfer-Encoding: identity', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunked, gzip (chunked must be the final coding)', async () => {
    // RFC 9112 §6.1: chunked MUST be the final coding when used.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('accepts Transfer-Encoding: gzip, chunked (chunked is the final coding)', async () => {
    // RFC 9112 §6.1: legal — the gateway just sees chunked framing and
    // delivers the gzip-encoded body bytes through. Decoding gzip is the
    // caller's job.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ));
    expect(await collectBody(r)).toBe('hello');
  });

  it('rejects Transfer-Encoding: chunked listed twice (across two headers)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_DOUBLE_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunked, chunked within one header value', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_DOUBLE_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunkedchunked (substring match must not enable chunked)', async () => {
    // llhttp test/response/transfer-encoding.md: the literal token must
    // be `chunked`, never a token that contains `chunked` as a substring.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunkedchunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('does not treat Content-Length-X as Content-Length (prefix match must not fire)', async () => {
    // llhttp test/response/content-length.md: a header that merely starts
    // with the literal `Content-Length` is not Content-Length.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length-X: 0\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n',
    ));
    expect(await collectBody(r)).toBe('OK');
  });

  it('accepts Content-Length with surrounding whitespace (OWS trimmed by header parser)', async () => {
    // The header value parser strips OWS before storing the raw value, so
    // a CL of `   5   ` reaches the framing layer as `5`.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length:   5   \r\n\r\nhello',
    ));
    expect(await collectBody(r)).toBe('hello');
  });
});

describe('parseHttpResponse — Content-Length value grammar', () => {
  it('rejects Content-Length: -1 (RFC 9112 §8.6)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 1.5 (must be a non-negative integer)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 1.5\r\n\r\nh')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 0xa (hex prefix is not allowed)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0xa\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 12abc (trailing non-digit garbage)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 12abc\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 1 1 (RFC 9112 §8.6 forbids embedded space)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 1 1\r\n\r\nhh')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length with a leading + sign', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: +5\r\n\r\nhello')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects an empty Content-Length value', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length:\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('accepts Content-Length: 0 with no body bytes', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(await collectBody(r)).toBe('');
  });

  it('accepts a large Content-Length value (within 32-bit range)', async () => {
    const len = 70_000;
    const fake = makeFakeDuplex();
    fake.respond(`HTTP/1.1 200 OK\r\nContent-Length: ${len}\r\n\r\n`);
    fake.respond(new Uint8Array(len).fill(0x61));
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    const buf = await collectBodyBytes(resp);
    expect(buf.byteLength).toBe(len);
  });
});

describe('parseHttpResponse — body framing (Content-Length boundaries)', () => {
  it('errors with TRAILING_BODY_BYTES when CL is satisfied and more bytes follow', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'TRAILING_BODY_BYTES',
    });
  });

  it('errors with TRAILING_BODY_BYTES when CL: 0 is followed by any body byte', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nX');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'TRAILING_BODY_BYTES',
    });
  });

  it('errors with EOF when CL exceeds the available bytes', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'EOF',
    });
  });

  it('returns exactly CL bytes when the upstream delivers more in the same packet', async () => {
    // Body bytes split across two transport reads, with the first delivering
    // both the header and the entire CL-satisfied body in one chunk.
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello');
  });

  it('streams CL body across multiple transport reads', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello');
    fake.respond(' world');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('reads to EOF when no framing headers are present (HTTP/1.1)', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\n\r\nbody bytes');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('body bytes');
  });

  it('returns an empty body when CL: 0 with no following bytes', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(resp.status).toBe(200);
    expect(await collectBody(resp)).toBe('');
  });
});

describe('fetchOnStream — request-side header validation (RFC 9110 §5.6.2 / §5.5)', () => {
  // RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" /
  // "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA. Anything
  // outside that set in a request header NAME is a smuggling vector — the
  // serialized `${k}: ${v}\r\n` line would inject extra header lines.
  const reqHeaderName = async (name: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', [name]: 'v' } },
    ).catch((e: unknown) => e);
  };

  const FORBIDDEN_NAMES: Record<string, string> = {
    'space inside name': 'X Foo',
    'TAB inside name': 'X\tFoo',
    'CR': 'X\rFoo',
    'LF': 'X\nFoo',
    'NUL': 'X Foo',
    'DEL (0x7f)': 'XFoo',
    'parenthesis (open)': 'X(Foo',
    'parenthesis (close)': 'X)Foo',
    'angle bracket <': 'X<Foo',
    'angle bracket >': 'X>Foo',
    'at sign': 'X@Foo',
    'comma': 'X,Foo',
    'semicolon': 'X;Foo',
    'colon': 'X:Foo',
    'backslash': 'X\\Foo',
    'double quote': 'X"Foo',
    'forward slash': 'X/Foo',
    'square bracket [': 'X[Foo',
    'square bracket ]': 'X]Foo',
    'question mark': 'X?Foo',
    'equals': 'X=Foo',
    'curly brace {': 'X{Foo',
    'curly brace }': 'X}Foo',
  };

  for (const [label, name] of Object.entries(FORBIDDEN_NAMES)) {
    it(`rejects a request header name with ${label}`, async () => {
      const err = await reqHeaderName(name);
      expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
    });
  }

  it('rejects an empty request header name', async () => {
    const err = await reqHeaderName('');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  // RFC 9110 §5.5: field-value control bytes (NUL, CR, LF, DEL) injected
  // by a caller would smuggle a fresh header onto the wire after our
  // `${k}: ${v}\r\n` serialization.
  const reqHeaderValue = async (value: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'X-Test': value } },
    ).catch((e: unknown) => e);
  };

  it('rejects a request header value containing CR (CRLF injection prevention)', async () => {
    const err = await reqHeaderValue('foo\rEvil: bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing LF (LF injection prevention)', async () => {
    const err = await reqHeaderValue('foo\nEvil: bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing NUL', async () => {
    const err = await reqHeaderValue('foo bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing DEL (0x7f)', async () => {
    const err = await reqHeaderValue('foobar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('accepts a request header value containing the typical printable special characters', async () => {
    // ; , = ( ) " < > [ ] { } @ / ? — all allowed in field-value.
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': 'a;b,c=d (e) [f] {g} <h>/?@' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: a;b,c=d (e) [f] {g} <h>/?@\r\n');
  });

  it('accepts a request header value containing the legitimate token specials', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': '!#$%&\'*+-.^_`|~' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: !#$%&\'*+-.^_`|~\r\n');
  });

  it('rejects every C0 control byte except HTAB (0x09) in a request header value (RFC 9110 §5.5 field-vchar)', async () => {
    // VCHAR is %x21-7E; the only control byte field-content lets through
    // is HTAB. The request validator covers the full C0 range — the
    // response parser already enforces the same shape, so symmetry
    // closes a smuggling-adjacent path on the request side.
    for (let b = 0x01; b <= 0x1f; b++) {
      if (b === 0x09) continue;
      const err = await reqHeaderValue(`a${String.fromCharCode(b)}b`);
      expect(err, `byte 0x${b.toString(16)}`).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
    }
  });

  it('accepts HTAB (0x09) inside a request header value (RFC 9110 §5.5 field-content)', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': 'a\tb' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: a\tb\r\n');
  });
});

describe('fetchOnStream — request-method handling', () => {
  it('rejects a HEAD request at this layer (RFC 9110 §6.4.1; framing would hang)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'HEAD', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'HEAD_REQUEST_REJECTED',
    });
  });

  it('rejects a HEAD request regardless of letter case (head)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'head', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({ code: 'HEAD_REQUEST_REJECTED' });
  });

  it('rejects a HEAD request regardless of letter case (Head)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'Head', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({ code: 'HEAD_REQUEST_REJECTED' });
  });
});

describe('fetchOnStream — request body serialization', () => {
  it('serializes a Uint8Array body in a single write when it fits in the default chunk size', async () => {
    const body = new TextEncoder().encode('payload');
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Content-Length: 7\r\n');
    expect(text.endsWith('\r\n\r\npayload')).toBe(true);
  });

  it('splits a body that exceeds bodyWriteChunkSize across multiple writes', async () => {
    // 8 chunks of 16 bytes each = 128 bytes total.
    const body = new Uint8Array(128).fill(0x41);
    const writeSizes: number[] = [];
    const fake = makeFakeDuplex();
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeSizes.push(chunk.byteLength);
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body },
      { bodyWriteChunkSize: 16 },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    // First write is the head; the next eight are 16 bytes each.
    expect(writeSizes.length).toBe(9);
    expect(writeSizes.slice(1)).toEqual([16, 16, 16, 16, 16, 16, 16, 16]);
  });

  it('does not write any body bytes when body is undefined', async () => {
    const fake = makeFakeDuplex();
    const writeCount = { n: 0 };
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeCount.n++;
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(writeCount.n).toBe(1);
  });

  it('writes only the head when body is an empty Uint8Array', async () => {
    const fake = makeFakeDuplex();
    const writeCount = { n: 0 };
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeCount.n++;
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body: new Uint8Array(0) },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(writeCount.n).toBe(1);
    // No Content-Length is added for a zero-byte body — matches the
    // current policy (only set CL when bodyLen > 0).
    expect(decodeAscii(fake.written())).not.toMatch(/Content-Length:/i);
  });

  it('preserves caller-set Accept-Encoding rather than overriding to identity', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'Accept-Encoding': 'gzip' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Accept-Encoding: gzip\r\n');
    expect(text).not.toContain('Accept-Encoding: identity\r\n');
  });

  it('drops the caller Connection header regardless of case', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'CONNECTION': 'keep-alive' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Connection: close\r\n');
    expect(text).not.toContain('keep-alive');
  });

  it('drops a caller transfer-encoding header regardless of case', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'POST',
        path: '/',
        headers: { Host: 'h', 'transfer-encoding': 'chunked' },
        body: new TextEncoder().encode('x'),
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).not.toMatch(/transfer-encoding/i);
  });
});
