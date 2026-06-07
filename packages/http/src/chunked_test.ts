import { describe, expect, it } from 'vitest';

import { decodeChunked, HttpProtocolError } from './index.ts';

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  let out = '';
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
};

const drainExpectError = async (stream: ReadableStream<Uint8Array>): Promise<unknown> => {
  const reader = stream.getReader();
  while (true) {
    try {
      const { done } = await reader.read();
      if (done) return new Error('chunked stream closed without an error');
    } catch (e) {
      return e;
    }
  }
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const fromString = (s: string): { reader: ReadableStreamDefaultReader<Uint8Array>; head: Uint8Array } => {
  // The decoder takes a head buffer + a reader for the rest. Empty `head`
  // and the entire stream pre-loaded mirrors the realistic case where the
  // response head got peeled off in the same chunk as the first body bytes.
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc(s)); c.close(); },
  });
  return { reader: stream.getReader(), head: new Uint8Array(0) };
};

describe('decodeChunked — RFC 9112 §7.1 happy path', () => {
  it('concatenates chunks split into multiple size+data records', async () => {
    // Three chunks: "Wiki" (4), "pedia" (5), " in chunks." (B = 11).
    const input = '4\r\nWiki\r\n5\r\npedia\r\nB\r\n in chunks.\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('Wikipedia in chunks.');
  });

  it('tolerates chunk extensions after a semicolon and ignores them', async () => {
    const input = '5;name=foo\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('consumes (and discards) trailing headers after the 0-sized terminator', async () => {
    const input = '5\r\nhello\r\n0\r\nX-Trailer: t1\r\nX-Trailer-2: t2\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });
});

describe('decodeChunked — error vectors', () => {
  it('errors on a hex size line containing non-hex bytes', async () => {
    const input = '5g\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/bad size line/);
  });

  it('errors on an empty size line', async () => {
    const input = '\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
  });

  it('errors when EOF arrives mid-data', async () => {
    const input = '5\r\nhel'; // missing two more bytes + CRLF + 0
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/EOF mid-data/);
  });

  it('errors when EOF arrives in the trailers block before the final CRLF', async () => {
    const input = '5\r\nhello\r\n0\r\nX-Trailer: t1\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/EOF in trailers/);
  });

  it('errors when the data block is not followed by CRLF', async () => {
    // Five payload bytes, then garbage instead of CRLF.
    const input = '5\r\nhelloXX0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/missing CRLF/);
  });
});

describe('decodeChunked — incremental reads', () => {
  it('handles chunks that arrive split across many ReadableStream chunks', async () => {
    const pieces = [
      '4\r',
      '\nWi', 'ki', '\r\n',
      '5\r\np', 'ed', 'ia', '\r\n',
      '0\r\n\r\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pieces) c.enqueue(enc(p));
        c.close();
      },
    });
    const out = await drain(decodeChunked(stream.getReader(), new Uint8Array(0)));
    expect(out).toBe('Wikipedia');
  });
});
