// Run an HTTP/1.1 request over an already-established duplex byte stream.
// Used both for native sockets that expose readable/writable directly and
// for our userspace-TLS-wrapped streams.

import { concat, copy, findDoubleCrlf } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import type { DuplexStream, HttpRequest } from './types.ts';

export interface FetchOnStreamOptions {
  /**
   * Bytes prepended to the very first network write — concatenated with the
   * HTTP/1.1 request head into a single `writer.write()` call. Lets a
   * caller coalesce a transport-handshake fragment with the request head
   * into one packet when an inspecting peer expects them in the same
   * record.
   */
  prefix?: Uint8Array;
  /**
   * Plaintext chunk size used when streaming the request body to the
   * writer. Each `writer.write()` maps 1:1 to one userspace-TLS record
   * (when the writer is a `userspaceTls` stream), so the value tunes the
   * trade-off between AEAD-record overhead and per-write microtask cost.
   * Defaults to 16384 bytes.
   */
  bodyWriteChunkSize?: number;
}

// ASCII text decoders are stateless when used with single-shot decode().
// One module-scoped instance is shared so the per-response and per-chunk
// parsers don't allocate a fresh decoder for each line. Strict mode on
// the header-bytes decoder turns non-ASCII garbage into a thrown error
// rather than silently mojibake'd Latin-1 (RFC 9112 §5 forbids non-ASCII
// in header field bytes).
const STRICT_ASCII = new TextDecoder('utf-8', { fatal: true });
const LENIENT_ASCII = new TextDecoder();

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const validateRequestHeaderName = (name: string): void => {
  if (!TCHAR.test(name)) {
    throw new HttpProtocolError(
      `caller-supplied header name is not a valid token: ${JSON.stringify(name)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.6.2' },
    );
  }
};

const validateRequestHeaderValue = (name: string, value: string): void => {
  // RFC 9110 §5.5: field-value = *( field-content / obs-text ). CR, LF,
  // and NUL inside a value would either be a smuggling attempt (CR/LF
  // injecting a fresh header line into the request) or a transport-level
  // garbage byte. Reject DEL (0x7f) too — it's the lone CTL not covered
  // by the obs-text range.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0 || c === 0x0a || c === 0x0d || c === 0x7f) {
      throw new HttpProtocolError(
        `caller-supplied header value for ${JSON.stringify(name)} contains a forbidden control byte`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.5' },
      );
    }
  }
};

export const fetchOnStream = async (
  stream: DuplexStream,
  request: HttpRequest,
  opts?: FetchOnStreamOptions,
): Promise<Response> => {
  // RFC 9110 §6.4.1: a HEAD response carries no body even when
  // Content-Length is set. Detecting that here is a one-line carve-out,
  // but the chunked/length body parsers below would otherwise hang
  // waiting for body bytes that the server is not sending — so refuse
  // HEAD outright at this layer. Callers that need HEAD can build the
  // response themselves off the headers we'd parse.
  if (request.method.toUpperCase() === 'HEAD') {
    throw new HttpProtocolError(
      'HEAD requests are not supported by this layer',
      'HEAD_REQUEST_REJECTED',
      { rfc: 'RFC 9110 §6.4.1' },
    );
  }

  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();
  // Normalize the request header block in a single pass:
  //   - drop Content-Length / Transfer-Encoding — the buffered body's
  //     exact length is the source of truth at this layer, and a chunked
  //     encoding from the runtime fetch path would leave the body wrapped
  //     in chunk markers we cannot decode here.
  //   - drop any Connection case-variant — this layer is one-shot per
  //     duplex (we always emit Connection: close below) and a caller-
  //     supplied `keep-alive` would mislead the upstream into reusing a
  //     transport we plan to tear down.
  //   - track whether Accept-Encoding is set so we can default it to
  //     `identity` below without a second pass over the header map.
  //   - validate every name/value the caller passes through so a
  //     ${k}: ${v}\r\n serialization can't smuggle a fresh header line
  //     onto the wire.
  const headers: Record<string, string> = {};
  let hasAcceptEncoding = false;
  for (const [k, v] of Object.entries(request.headers)) {
    validateRequestHeaderName(k);
    validateRequestHeaderValue(k, v);
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    if (lk === 'accept-encoding') hasAcceptEncoding = true;
    headers[k] = v;
  }
  headers.Connection = 'close';
  if (!hasAcceptEncoding) headers['Accept-Encoding'] = 'identity';
  // Without Content-Length on a body-bearing request, RFC 9112 §6 has the
  // server treat the message as zero-length — a serialized POST emitted
  // with no framing at all silently loses its body on strict upstreams.
  const bodyLen = request.body?.byteLength ?? 0;
  if (bodyLen > 0) headers['Content-Length'] = String(bodyLen);

  const requestLine = `${request.method} ${request.path} HTTP/1.1\r\n`;
  let head = requestLine;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBytes = enc.encode(head);
  // Prepend the optional prefix into the same write so the leading record
  // contains both the prefix and the request head (see
  // FetchOnStreamOptions.prefix).
  if (opts?.prefix && opts.prefix.byteLength > 0) {
    const merged = new Uint8Array(opts.prefix.byteLength + headBytes.byteLength);
    merged.set(opts.prefix, 0);
    merged.set(headBytes, opts.prefix.byteLength);
    await writer.write(merged);
  } else {
    await writer.write(headBytes);
  }
  if (request.body?.byteLength) {
    const chunkSize = opts?.bodyWriteChunkSize ?? 16384;
    let off = 0;
    while (off < request.body.byteLength) {
      const slice = request.body.subarray(off, Math.min(off + chunkSize, request.body.byteLength));
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
  // forever can't exhaust the runtime's heap. 64 KiB is two orders of
  // magnitude over any sane response-header block.
  const HEADER_BUFFER_CAP = 64 * 1024;
  let headerEnd = -1;
  while (headerEnd < 0) {
    const { value, done } = await reader.read();
    if (done) {
      throw new HttpProtocolError(
        `unexpected EOF before headers; got ${buffer.byteLength} bytes`,
        'EOF',
      );
    }
    buffer = concat(buffer, value);
    headerEnd = findDoubleCrlf(buffer);
    if (headerEnd < 0 && buffer.byteLength > HEADER_BUFFER_CAP) {
      throw new HttpProtocolError(
        `HTTP/1.1 response headers exceeded ${HEADER_BUFFER_CAP} bytes without a terminator`,
        'HEADER_BUFFER_OVERFLOW',
      );
    }
  }

  const headerBytes = buffer.subarray(0, headerEnd);
  const remainder = copy(buffer.subarray(headerEnd + 4));

  let headerText: string;
  try {
    headerText = STRICT_ASCII.decode(headerBytes);
  } catch (cause) {
    throw new HttpProtocolError(
      'non-ASCII bytes in response headers',
      'BAD_HEADERS',
      { cause, rfc: 'RFC 9112 §5' },
    );
  }
  const lines = headerText.split('\r\n');
  const statusLine = lines.shift()!;
  // RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
  // Require both spaces (strict). Reason-phrase may be empty per
  // RFC 7230 erratum 4087.
  const m = /^HTTP\/(1\.[01]) (\d{3}) (.*)$/.exec(statusLine);
  if (!m) {
    throw new HttpProtocolError(
      `bad status line: ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
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
  // Bound the per-response header count alongside the existing 64 KiB
  // header-buffer cap. The byte cap already implies a rough ceiling, but
  // a stream of `A:` lines could stay under 64 KiB while still stuffing
  // tens of thousands of entries into the Headers map.
  const MAX_HEADER_COUNT = 100;
  if (lines.length - 1 > MAX_HEADER_COUNT) {
    throw new HttpProtocolError(
      `HTTP/1.1 response has ${lines.length - 1} header lines (max ${MAX_HEADER_COUNT})`,
      'TOO_MANY_HEADERS',
    );
  }
  for (const line of lines) {
    if (line.length === 0) continue;
    // RFC 9112 §5.2: obs-fold (a continuation line beginning with SP/HTAB)
    // is deprecated and MUST be rejected.
    const first = line.charCodeAt(0);
    if (first === 0x20 || first === 0x09) {
      throw new HttpProtocolError(
        'obs-fold not supported (RFC 9112 §5.2)',
        'OBS_FOLD',
        { rfc: 'RFC 9112 §5.2' },
      );
    }
    const idx = line.indexOf(':');
    if (idx < 0) {
      throw new HttpProtocolError(
        `header line missing colon: ${JSON.stringify(line)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
    const name = line.slice(0, idx);
    if (!TCHAR.test(name)) {
      throw new HttpProtocolError(
        `invalid header name: ${JSON.stringify(name)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.1' },
      );
    }
    const value = line.slice(idx + 1).replace(/^[\t ]+|[\t ]+$/g, '');
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0 || c === 0x7f) {
        throw new HttpProtocolError(
          `invalid byte in header value for ${JSON.stringify(name)}`,
          'BAD_HEADERS',
          { rfc: 'RFC 9110 §5.5' },
        );
      }
    }
    const lower = name.toLowerCase();
    if (lower === 'content-length') rawContentLengths.push(value);
    else if (lower === 'transfer-encoding') rawTransferEncodings.push(value);
    respHeaders.append(name, value);
  }

  // RFC 9112 §6.3: a message with both Transfer-Encoding and
  // Content-Length is an error (the sender is broken or actively
  // smuggling). Reject loud rather than picking one.
  if (rawTransferEncodings.length > 0 && rawContentLengths.length > 0) {
    throw new HttpProtocolError(
      'HTTP/1.1 response has both Transfer-Encoding and Content-Length',
      'CL_AND_TE',
      { rfc: 'RFC 9112 §6.3' },
    );
  }
  // RFC 9112 §6.3: multiple Content-Length values are an error unless
  // every value is the same single token. We forbid duplicates outright.
  if (rawContentLengths.length > 1) {
    throw new HttpProtocolError(
      `HTTP/1.1 response has ${rawContentLengths.length} Content-Length headers`,
      'MULTIPLE_CL',
      { rfc: 'RFC 9112 §6.3' },
    );
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
    throw new HttpProtocolError(
      `HTTP/1.1 response has Transfer-Encoding without chunked: ${teTokens.join(',')}`,
      'TE_NOT_CHUNKED',
      { rfc: 'RFC 9112 §6.1' },
    );
  }
  if (teTokens.filter(t => t === 'chunked').length > 1) {
    throw new HttpProtocolError(
      'HTTP/1.1 response has chunked listed more than once in Transfer-Encoding',
      'TE_DOUBLE_CHUNKED',
      { rfc: 'RFC 9112 §6.1' },
    );
  }
  const contentLength = rawContentLengths[0] ?? null;

  let body: ReadableStream<Uint8Array>;
  if (teIsChunked) {
    body = decodeChunked(reader, remainder);
    respHeaders.delete('transfer-encoding');
  } else if (contentLength !== null) {
    const total = parseInt(contentLength, 10);
    if (!Number.isFinite(total) || total < 0 || String(total) !== contentLength) {
      throw new HttpProtocolError(
        `HTTP/1.1 response has malformed Content-Length: ${JSON.stringify(contentLength)}`,
        'BAD_CL',
        { rfc: 'RFC 9112 §6.2' },
      );
    }
    body = lengthBody(reader, remainder, total);
  } else {
    body = untilEofBody(reader, remainder);
  }

  return new Response(body, { status, headers: respHeaders });
};

// Body framing — Content-Length. The first chunk can be a partial of the
// header buffer's remainder; we copy() it so the body stream owns its
// memory and the header parser's buffer can be released. After `total`
// bytes have been delivered, any further byte from the transport is a
// framing error (the next message of a keep-alive connection in our
// non-keep-alive world means the upstream is broken).
const lengthBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  total: number,
): ReadableStream<Uint8Array> => {
  let consumed = 0;
  const ownedHead = copy(head);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (ownedHead.byteLength > total) {
        controller.error(new HttpProtocolError(
          `trailing bytes after Content-Length boundary (${ownedHead.byteLength - total} extra in head)`,
          'TRAILING_BODY_BYTES',
        ));
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
        return;
      }
      if (ownedHead.byteLength) {
        controller.enqueue(ownedHead);
        consumed += ownedHead.byteLength;
      }
      if (consumed >= total) {
        controller.close();
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
      }
    },
    async pull(controller) {
      while (consumed < total) {
        const { value, done } = await reader.read();
        if (done) {
          controller.error(new HttpProtocolError(
            `upstream EOF after ${consumed}/${total} body bytes`,
            'EOF',
          ));
          return;
        }
        const remain = total - consumed;
        if (value.byteLength <= remain) {
          controller.enqueue(copy(value));
          consumed += value.byteLength;
        } else {
          controller.enqueue(copy(value.subarray(0, remain)));
          consumed += remain;
          controller.error(new HttpProtocolError(
            `trailing bytes after Content-Length boundary (${value.byteLength - remain} extra)`,
            'TRAILING_BODY_BYTES',
          ));
          try { await reader.cancel(); } catch { /* reader already cancelled */ }
          return;
        }
        if (consumed >= total) {
          controller.close();
          try { await reader.cancel(); } catch { /* reader already cancelled */ }
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};

// Body framing — read until EOF. The head buffer is copy()'d to match
// lengthBody's ownership rule: the body stream owns its bytes regardless
// of which framing path produced them.
const untilEofBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> => {
  const ownedHead = copy(head);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (ownedHead.byteLength) controller.enqueue(ownedHead);
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
  // Search position into `buf` for the next CR. `findCrlf` is otherwise
  // O(n) per call across the whole buffer; on a stream of small chunks
  // that turns into O(n²) total work. We track how far we've already
  // scanned so each new search resumes where the previous one left off.
  let scanFrom = 0;
  let state: 'size' | 'data' | 'after-data-crlf' | 'trailers' | 'done' = 'size';
  let need = 0;
  // Bound how much the trailer block can grow before we give up. Trailers
  // are unusual in practice; 64 KiB matches the response-header cap.
  const MAX_TRAILERS_BYTES = 64 * 1024;
  // Bound the chunk-size line (size hex + extensions + CRLF). Real chunk
  // sizes never need more than a handful of hex digits; an unboundedly
  // long extension is the only way to reach this cap, and it's a DoS.
  const MAX_CHUNK_SIZE_LINE = 1024;
  let trailerBytesSeen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (state === 'size') {
          const idx = findCrlfFrom(buf, scanFrom);
          if (idx < 0) {
            if (buf.byteLength > MAX_CHUNK_SIZE_LINE) {
              controller.error(new HttpProtocolError(
                `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
                'CHUNK_TOO_LONG',
              ));
              return;
            }
            scanFrom = Math.max(0, buf.byteLength - 1);
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF in size', 'EOF'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          if (idx > MAX_CHUNK_SIZE_LINE) {
            controller.error(new HttpProtocolError(
              `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
              'CHUNK_TOO_LONG',
            ));
            return;
          }
          const sizeLine = LENIENT_ASCII.decode(buf.subarray(0, idx));
          const semi = sizeLine.indexOf(';');
          const hex = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim();
          // Strict hex validation. parseInt('1f garbage', 16) returns 31 —
          // a smuggling-adjacent path. Require a pure run of hex digits;
          // chunk extensions (after the `;`) are dropped by the slice
          // above before we get here.
          if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
            controller.error(new HttpProtocolError(
              `chunked: bad size line ${JSON.stringify(sizeLine)}`,
              'CHUNK_BAD_SIZE',
            ));
            return;
          }
          // The regex above guarantees a non-empty pure-hex run, so parseInt
          // always yields a non-negative finite number — no further range
          // check is needed here.
          need = parseInt(hex, 16);
          buf = buf.subarray(idx + 2);
          scanFrom = 0;
          state = need === 0 ? 'trailers' : 'data';
        } else if (state === 'data') {
          if (buf.byteLength === 0) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF mid-data', 'EOF'));
              return;
            }
            buf = copy(more.value);
            continue;
          }
          const take = Math.min(buf.byteLength, need);
          controller.enqueue(copy(buf.subarray(0, take)));
          buf = buf.subarray(take);
          scanFrom = 0;
          need -= take;
          if (need === 0) state = 'after-data-crlf';
          return;
        } else if (state === 'after-data-crlf') {
          while (buf.byteLength < 2) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError(
                'chunked: EOF before CRLF after data',
                'EOF',
              ));
              return;
            }
            buf = concat(buf, more.value);
          }
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
            controller.error(new HttpProtocolError(
              'chunked: missing CRLF after data',
              'CHUNK_BAD_SIZE',
            ));
            return;
          }
          buf = buf.subarray(2);
          scanFrom = 0;
          state = 'size';
        } else if (state === 'trailers') {
          const idx = findCrlfFrom(buf, scanFrom);
          if (idx < 0) {
            trailerBytesSeen += buf.byteLength;
            if (trailerBytesSeen > MAX_TRAILERS_BYTES) {
              controller.error(new HttpProtocolError(
                `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
                'TRAILERS_TOO_LONG',
              ));
              return;
            }
            scanFrom = Math.max(0, buf.byteLength - 1);
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpProtocolError('chunked: EOF in trailers', 'EOF'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          if (idx === 0) {
            buf = buf.subarray(2);
            scanFrom = 0;
            state = 'done';
            controller.close();
            try { await reader.cancel(); } catch { /* reader already cancelled */ }
            return;
          }
          trailerBytesSeen += idx + 2;
          if (trailerBytesSeen > MAX_TRAILERS_BYTES) {
            controller.error(new HttpProtocolError(
              `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
              'TRAILERS_TOO_LONG',
            ));
            return;
          }
          buf = buf.subarray(idx + 2);
          scanFrom = 0;
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

const findCrlfFrom = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
};
