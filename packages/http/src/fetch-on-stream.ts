// Run an HTTP/1.1 request over an already-established duplex byte stream.
// Used both for native sockets that expose readable/writable directly and
// for our userspace-TLS-wrapped streams.

import { concat, copy, findDoubleCrlf } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import type { DuplexStream, HttpRequest } from './types.ts';

export interface FetchOnStreamOptions {
  /**
   * Bytes to prepend to the very first write — concatenated with the
   * HTTP/1.1 request head into a single writer.write() call. Trojan's
   * plain-HTTP path uses this to ride its 56-byte auth header in the
   * same record as the request line, avoiding sing-box's
   * fallback-disabled short-read on the leading record.
   */
  prefix?: Uint8Array;
}

export const fetchOnStream = async (
  stream: DuplexStream,
  request: HttpRequest,
  opts?: FetchOnStreamOptions,
): Promise<Response> => {
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();
  // Normalize the request header block in a single pass:
  //   - drop Content-Length / Transfer-Encoding — the buffered body's
  //     exact length is the source of truth at this layer, and a chunked
  //     encoding from the runtime fetch path would leave the body wrapped
  //     in chunk markers we cannot decode here.
  //   - drop any Connection case-variant — the gateway is one-shot per
  //     dial and a caller-supplied `keep-alive` would mislead the upstream
  //     into reusing a socket we plan to tear down.
  //   - track whether Accept-Encoding is set so we can default it to
  //     `identity` below without a second pass over the header map.
  const headers: Record<string, string> = {};
  let hasAcceptEncoding = false;
  for (const [k, v] of Object.entries(request.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    if (lk === 'accept-encoding') hasAcceptEncoding = true;
    headers[k] = v;
  }
  headers.Connection = 'close';
  if (!hasAcceptEncoding) headers['Accept-Encoding'] = 'identity';
  // Without Content-Length on a body-bearing request, RFC 9112 §6 has the
  // server treat the message as zero-length — that's how Copilot's
  // `invalid_request_body` surfaces when our serialized POST goes out with
  // no framing at all.
  const bodyLen = request.body?.byteLength ?? 0;
  if (bodyLen > 0) headers['Content-Length'] = String(bodyLen);

  const requestLine = `${request.method} ${request.path} HTTP/1.1\r\n`;
  let head = requestLine;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBytes = enc.encode(head);
  // Prepend the optional prefix into the same write so the leading record
  // contains both the prefix and the request head (Trojan plain-HTTP
  // depends on this; see FetchOnStreamOptions.prefix).
  if (opts?.prefix && opts.prefix.byteLength > 0) {
    const merged = new Uint8Array(opts.prefix.byteLength + headBytes.byteLength);
    merged.set(opts.prefix, 0);
    merged.set(headBytes, opts.prefix.byteLength);
    await writer.write(merged);
  } else {
    await writer.write(headBytes);
  }
  if (request.body?.byteLength) {
    // Match the inner TLS record size (16 KiB plaintext, per RFC 8446 §5.1).
    // Each call to writer.write() on the userspace-TLS stream maps 1:1 to
    // an AEAD-sealed record, so larger chunks just trigger reclaim's own
    // chunkUint8Array re-split, while smaller chunks add per-call await
    // overhead. 16 KiB is the sweet spot for the userspace path; native
    // sockets are insensitive to chunk size.
    const CHUNK = 16384;
    let off = 0;
    while (off < request.body.byteLength) {
      const slice = request.body.subarray(off, Math.min(off + CHUNK, request.body.byteLength));
      await writer.write(slice);
      off += slice.byteLength;
    }
  }
  writer.releaseLock();

  return await parseHttpResponse(stream.readable);
};

// Parse an HTTP/1.1 response off a byte-stream reader. Exported for advanced
// callers that already own the readable (e.g. tests, or transports that
// pre-process the response head before re-injecting bytes).
export const parseHttpResponse = async (readable: ReadableStream<Uint8Array>): Promise<Response> => {
  const reader = readable.getReader();
  let buffer = new Uint8Array(0);

  // Cap accumulation so a misbehaving upstream that streams headers
  // forever can't OOM the Worker. 64 KiB is two orders of magnitude over
  // any sane response-header block.
  const HEADER_BUFFER_CAP = 64 * 1024;
  let headerEnd = -1;
  while (headerEnd < 0) {
    const { value, done } = await reader.read();
    if (done) throw new HttpProtocolError(`unexpected EOF before headers; got ${buffer.byteLength} bytes`);
    buffer = concat(buffer, value);
    headerEnd = findDoubleCrlf(buffer);
    if (headerEnd < 0 && buffer.byteLength > HEADER_BUFFER_CAP) {
      throw new HttpProtocolError(`HTTP/1.1 response headers exceeded ${HEADER_BUFFER_CAP} bytes without a terminator`);
    }
  }

  const headerBytes = buffer.subarray(0, headerEnd);
  const remainder = copy(buffer.subarray(headerEnd + 4));

  const headerText = new TextDecoder().decode(headerBytes);
  const lines = headerText.split('\r\n');
  const statusLine = lines.shift()!;
  const m = /^HTTP\/(1\.[01]) (\d{3}) ?(.*)$/.exec(statusLine);
  if (!m) throw new HttpProtocolError(`bad status line: ${JSON.stringify(statusLine)}`);
  const status = parseInt(m[2]!, 10);

  const respHeaders = new Headers();
  // Track raw header lines so we can validate framing-related fields off
  // the unmerged values. `Headers.get('content-length')` collapses two
  // separate `Content-Length` headers into `5, 5` and `parseInt` then
  // accepts the first value silently — that's the classic HTTP-smuggling
  // shape (RFC 9112 §6.3 mandates rejecting messages with multiple
  // distinct Content-Lengths). Same applies to the chunked detection.
  const rawContentLengths: string[] = [];
  const rawTransferEncodings: string[] = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const lower = name.toLowerCase();
    if (lower === 'content-length') rawContentLengths.push(value);
    else if (lower === 'transfer-encoding') rawTransferEncodings.push(value);
    respHeaders.append(name, value);
  }

  // RFC 9112 §6.3: a message with both Transfer-Encoding and
  // Content-Length is an error (the sender is broken or actively
  // smuggling). Reject loud rather than picking one.
  if (rawTransferEncodings.length > 0 && rawContentLengths.length > 0) {
    throw new HttpProtocolError('HTTP/1.1 response has both Transfer-Encoding and Content-Length');
  }
  // RFC 9112 §6.3: multiple Content-Length values are an error unless
  // every value is the same single token. We forbid duplicates outright.
  if (rawContentLengths.length > 1) {
    throw new HttpProtocolError(`HTTP/1.1 response has ${rawContentLengths.length} Content-Length headers`);
  }

  // Parse Transfer-Encoding as a token list; `chunked` MUST be the final
  // (or only) coding. Anything else (gzip, identity, etc.) framed without
  // chunked has no defined termination and we don't decode them anyway.
  const teTokens = rawTransferEncodings
    .flatMap(v => v.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(t => t !== '');
  const teIsChunked = teTokens.length > 0 && teTokens[teTokens.length - 1] === 'chunked';
  if (teTokens.length > 0 && !teIsChunked) {
    throw new HttpProtocolError(`HTTP/1.1 response has Transfer-Encoding without chunked: ${teTokens.join(',')}`);
  }
  if (teTokens.filter(t => t === 'chunked').length > 1) {
    throw new HttpProtocolError('HTTP/1.1 response has chunked listed more than once in Transfer-Encoding');
  }
  const contentLength = rawContentLengths[0] ?? null;

  let body: ReadableStream<Uint8Array>;
  let mode: 'chunked' | 'length' | 'eof';
  if (teIsChunked) {
    body = decodeChunked(reader, remainder);
    mode = 'chunked';
    respHeaders.delete('transfer-encoding');
  } else if (contentLength !== null) {
    const total = parseInt(contentLength, 10);
    if (!Number.isFinite(total) || total < 0 || String(total) !== contentLength) {
      throw new HttpProtocolError(`HTTP/1.1 response has malformed Content-Length: ${JSON.stringify(contentLength)}`);
    }
    body = lengthBody(reader, remainder, total);
    mode = 'length';
  } else {
    body = untilEofBody(reader, remainder);
    mode = 'eof';
  }
  respHeaders.set('x-content-stream-mode', mode);

  return new Response(body, { status, headers: respHeaders });
};

const lengthBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  total: number,
): ReadableStream<Uint8Array> => {
  let consumed = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (head.byteLength) {
        const take = Math.min(head.byteLength, total);
        controller.enqueue(head.subarray(0, take));
        consumed += take;
      }
      if (consumed >= total) {
        controller.close();
        try { await reader.cancel(); } catch {}
      }
    },
    async pull(controller) {
      while (consumed < total) {
        const { value, done } = await reader.read();
        if (done) {
          controller.error(new HttpProtocolError(`upstream EOF after ${consumed}/${total} body bytes`));
          return;
        }
        const remain = total - consumed;
        if (value.byteLength <= remain) {
          controller.enqueue(copy(value));
          consumed += value.byteLength;
        } else {
          controller.enqueue(copy(value.subarray(0, remain)));
          consumed += remain;
        }
        if (consumed >= total) {
          controller.close();
          try { await reader.cancel(); } catch {}
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};

const untilEofBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(copy(value));
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};

// Decode an HTTP/1.1 chunked transfer-encoding body. Exported for advanced
// callers that already hold a reader into a chunked stream.
export const decodeChunked = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> => {
  let buf = head;
  let state: 'size' | 'data' | 'after-data-crlf' | 'trailers' | 'done' = 'size';
  let need = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (state === 'size') {
          const idx = findCrlf(buf);
          if (idx < 0) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF in size'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          const sizeLine = new TextDecoder().decode(buf.subarray(0, idx));
          const semi = sizeLine.indexOf(';');
          const hex = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim();
          // Strict hex validation. parseInt('1f garbage', 16) returns 31 —
          // a smuggling-adjacent path. Require a pure run of hex digits;
          // chunk extensions (after the `;`) are dropped by the slice
          // above before we get here.
          if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
            controller.error(new HttpProtocolError(`chunked: bad size line ${JSON.stringify(sizeLine)}`));
            return;
          }
          // The regex above guarantees a non-empty pure-hex run, so parseInt
          // always yields a non-negative finite number — no further range
          // check is needed here.
          need = parseInt(hex, 16);
          buf = buf.subarray(idx + 2);
          state = need === 0 ? 'trailers' : 'data';
        } else if (state === 'data') {
          if (buf.byteLength === 0) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF mid-data'));
              return;
            }
            buf = copy(more.value);
            continue;
          }
          const take = Math.min(buf.byteLength, need);
          controller.enqueue(copy(buf.subarray(0, take)));
          buf = buf.subarray(take);
          need -= take;
          if (need === 0) state = 'after-data-crlf';
          return;
        } else if (state === 'after-data-crlf') {
          while (buf.byteLength < 2) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF before CRLF after data'));
              return;
            }
            buf = concat(buf, more.value);
          }
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
            controller.error(new HttpProtocolError('chunked: missing CRLF after data'));
            return;
          }
          buf = buf.subarray(2);
          state = 'size';
        } else if (state === 'trailers') {
          const idx = findCrlf(buf);
          if (idx < 0) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF in trailers'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          if (idx === 0) {
            buf = buf.subarray(2);
            state = 'done';
            controller.close();
            try { await reader.cancel(); } catch {}
            return;
          }
          buf = buf.subarray(idx + 2);
        } else {
          controller.close();
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};

const findCrlf = (buf: Uint8Array): number => {
  for (let i = 0; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
};
