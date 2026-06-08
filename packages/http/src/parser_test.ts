// Wire-level vectors covering the response-head parser: status line,
// header name grammar, header value grammar, OWS/whitespace, count caps.
// The vectors are deterministic and each `it(...)` asserts a specific
// HttpProtocolErrorCode (or success body) so a regression points to the
// exact RFC clause.

import { describe, expect, it } from 'vitest';

import { parseHttpResponse } from './fetch-on-stream.ts';
import { makeFakeDuplex } from './test-utils.ts';

const respondAndEnd = (head: string): ReadableStream<Uint8Array> => {
  const fake = makeFakeDuplex();
  fake.respond(head);
  fake.endResponse();
  return fake.readable;
};

describe('parseHttpResponse — status-line grammar', () => {
  it('accepts HTTP/1.0 200 OK', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('accepts HTTP/1.1 200 OK', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('accepts a long, punctuated reason phrase', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 a really long reason phrase, with spaces & punctuation, OK?\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.status).toBe(200);
  });

  it('accepts the upper end of the Response-constructible range (599)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 599 Strange\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(599);
  });

  it('accepts an unusual 4xx status (e.g. 418 I\'m a teapot)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 418 I\'m a teapot\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(418);
  });

  it('accepts the lower end of the Response-constructible range (200)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('rejects HTTP/2.0 — only HTTP/1.0 and HTTP/1.1 are supported', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/2.0 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTP/0.9', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/0.9 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTP/1.2', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.2 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 2-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 99 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 4-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 1000 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 1-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 2 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a non-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 abc OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a status code with embedded space', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 2 0 0 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a status line missing the SP after status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('accepts a status line with two SPs between code and reason (treated as leading SP in reason)', async () => {
    // Documenting current behavior: the regex anchors capture the first SP
    // between status and reason, and the duplicated SP is absorbed into the
    // reason-phrase capture. llhttp behaves similarly in lenient mode.
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200  OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('rejects a status line with two SPs between version and code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1  200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a TAB instead of SP after the version', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1\t200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a lowercase scheme (http/1.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('http/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a leading CR before the status line (CR-prefixed garbage)', async () => {
    await expect(parseHttpResponse(respondAndEnd('\rHTTP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects RTSP/1.1 — this layer is HTTP-only', async () => {
    await expect(parseHttpResponse(respondAndEnd('RTSP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects ICE/1.1 — this layer is HTTP-only', async () => {
    await expect(parseHttpResponse(respondAndEnd('ICE/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTPER/1.1 (close-but-wrong scheme)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTPER/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects an extra leading zero in the major version (HTTP/01.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/01.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects an LF-only line ending instead of CRLF', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\nContent-Length: 0\n\n'))).rejects.toMatchObject({
      code: 'EOF',
    });
  });

  it('rejects garbage before the status line', async () => {
    await expect(parseHttpResponse(respondAndEnd('garbage HTTP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });
});

describe('parseHttpResponse — header name grammar (RFC 9110 §5.1 token)', () => {
  // RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" /
  // "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
  const FORBIDDEN: Record<string, string> = {
    'space inside name': 'X Foo',
    'tab inside name': 'X\tFoo',
    'parenthesis (open)': 'X(Foo',
    'parenthesis (close)': 'X)Foo',
    'angle bracket <': 'X<Foo',
    'angle bracket >': 'X>Foo',
    'at sign': 'X@Foo',
    'comma': 'X,Foo',
    'semicolon': 'X;Foo',
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

  for (const [label, name] of Object.entries(FORBIDDEN)) {
    it(`rejects header name with ${label}`, async () => {
      await expect(parseHttpResponse(respondAndEnd(
        `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
      ))).rejects.toMatchObject({
        code: 'BAD_HEADERS',
      });
    });
  }

  it('rejects an empty header name (line starting with colon)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\n: foo\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects whitespace between header name and colon (RFC 9112 §5.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nFoo : bar\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a header line missing the colon', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nFoo bar\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it.each([
    ['exclamation mark', '!'],
    ['hash', '#'],
    ['dollar', '$'],
    ['percent', '%'],
    ['ampersand', '&'],
    ['apostrophe', '\''],
    ['asterisk', '*'],
    ['plus', '+'],
    ['hyphen', '-'],
    ['period', '.'],
    ['caret', '^'],
    ['underscore', '_'],
    ['backtick', '`'],
    ['pipe', '|'],
    ['tilde', '~'],
  ])('accepts the special tchar %s in header names', async (_label, ch) => {
    const name = `X${ch}Y`;
    const r = await parseHttpResponse(respondAndEnd(
      `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
    ));
    expect(r.headers.get(name.toLowerCase())).toBe('v');
  });

  it('accepts mixed-case header names and exposes them lowercased via Headers', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-MiXeD-CaSe: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x-mixed-case')).toBe('v');
  });

  it('accepts a header name made of only digits (RFC 9110 §5.6.2)', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\n12345: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('12345')).toBe('v');
  });

  it('accepts a single-character header name', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nA: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('a')).toBe('v');
  });

  it('rejects a DEL byte in the header name', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX'));
    fake.respond(new Uint8Array([0x7f]));
    fake.respond('Foo: v\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a NUL byte in the header name', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX'));
    fake.respond(new Uint8Array([0x00]));
    fake.respond('Foo: v\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });
});

describe('parseHttpResponse — header value grammar (RFC 9110 §5.5 field-value)', () => {
  it('accepts an empty value (`X:` with nothing after)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX-Empty:\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x-empty')).toBe('');
  });

  it('accepts an empty value with a single SP between colon and CRLF', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX-Empty: \r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x-empty')).toBe('');
  });

  it('trims a single leading SP before the value', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX: foo\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('trims multiple leading SPs and TABs before the value (OWS = *( SP / HTAB ))', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX:  \t  foo\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('trims trailing OWS from the value', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX: foo \t \r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('preserves internal SPs in the value', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX: foo bar baz\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x')).toBe('foo bar baz');
  });

  it('rejects a NUL (0x00) byte in the value', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: a'));
    fake.respond(new Uint8Array([0x00]));
    fake.respond('b\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a DEL (0x7f) byte in the value', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: a'));
    fake.respond(new Uint8Array([0x7f]));
    fake.respond('b\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects bytes that are not valid UTF-8 in the response header section (RFC 9112 §5)', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: '));
    // 0xff is invalid as a UTF-8 lead byte. The fatal decoder will throw.
    fake.respond(new Uint8Array([0xff]));
    fake.respond('\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('preserves duplicate-named headers as a comma-joined Headers entry', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Dup: a\r\nX-Dup: b\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x-dup')).toMatch(/^a,\s?b$/);
  });

  it('rejects obs-fold continuation that starts with SP (RFC 9112 §5.2)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n line2\r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('rejects obs-fold continuation that starts with TAB (RFC 9112 §5.2)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n\tline2\r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('rejects obs-fold even when the continuation is just SP+CRLF (empty fold)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n \r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('accepts a value that itself contains a colon (only the first colon is the delimiter)', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nLocation: https://example.com:8443/x\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('location')).toBe('https://example.com:8443/x');
  });

  it('accepts a value with the legitimate special-character set { , ; = ( ) }', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset="utf-8" (preferred)\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('content-type')).toBe('text/html; charset="utf-8" (preferred)');
  });
});

describe('parseHttpResponse — DoS caps', () => {
  it('rejects a response with more than 100 header lines as TOO_MANY_HEADERS', async () => {
    const lines = ['HTTP/1.1 200 OK'];
    for (let i = 0; i < 110; i++) lines.push(`X-${i}: v`);
    lines.push('Content-Length: 0');
    lines.push('');
    lines.push('');
    await expect(parseHttpResponse(respondAndEnd(lines.join('\r\n')))).rejects.toMatchObject({
      code: 'TOO_MANY_HEADERS',
    });
  });

  it('accepts a response at exactly the 100-header boundary', async () => {
    const lines = ['HTTP/1.1 200 OK'];
    for (let i = 0; i < 99; i++) lines.push(`X-${i}: v`);
    lines.push('Content-Length: 0');
    lines.push('');
    lines.push('');
    const r = await parseHttpResponse(respondAndEnd(lines.join('\r\n')));
    expect(r.status).toBe(200);
  });

  it('rejects a single header that grows past the 64 KiB header buffer', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nX-Big: ');
    fake.respond('a'.repeat(70 * 1024));
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'HEADER_BUFFER_OVERFLOW',
    });
  });

  it('rejects EOF before the header terminator with code EOF', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Type:'))).rejects.toMatchObject({
      code: 'EOF',
    });
  });

  it('accepts a response with zero headers', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\n\r\n'));
    expect(r.status).toBe(200);
  });
});
