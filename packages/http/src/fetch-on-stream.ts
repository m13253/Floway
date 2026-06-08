// Run an HTTP/1.1 request over an already-established duplex byte stream.
// Used both for native sockets that expose readable/writable directly and
// for our userspace-TLS-wrapped streams.

import { concat, copy, findDoubleCrlf } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import type { DuplexStream, HttpRequest, RawHttpResponse } from './types.ts';

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

// The header-bytes decoder is fatal-UTF-8 — but UTF-8 alone is too lax,
// because RFC 9112 §5 forbids any non-ASCII byte in the header section. A
// byte sequence like 0xc3 0xa9 ("é") is valid UTF-8, yet the spec rejects
// it. We therefore byte-scan for any value ≥ 0x80 before handing the bytes
// to this decoder. The decoder still earns its keep on the back end by
// rejecting invalid UTF-8 (e.g. lone 0xff), but the byte-scan is what
// makes the path RFC-compliant. Stateless when used through single-shot
// decode(); shared module-scope so the per-response parser never
// allocates a fresh decoder.
const ASCII_DECODER = new TextDecoder('utf-8', { fatal: true });
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
  // RFC 9110 §5.5: field-content = field-vchar / SP / HTAB / obs-fold;
  // field-vchar = VCHAR / obs-text. The legal byte set inside a value is
  // therefore HTAB (0x09), SP (0x20), VCHAR (0x21-0x7E), and obs-text
  // (0x80-0xFF). Anything else — NUL and the rest of the C0 control set
  // (0x01-0x08, 0x0B-0x1F; CR/LF call out the smuggling shape directly)
  // plus DEL (0x7F) — violates the grammar. The serialised `${k}: ${v}\r\n`
  // line would otherwise carry a control byte onto the wire, smuggling a
  // fresh header on CR/LF or rendering the value lossy on the others.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
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

  return toWebResponse(await parseHttpResponse(stream.readable));
};

/**
 * Bridge a wire-faithful {@link RawHttpResponse} to a Web `Response`. The
 * Web `Response` constructor rejects status outside 200..599 and rejects a
 * non-null body for 204/304 — both of which the wire can legitimately
 * carry — so the parser stays a pure wire decoder and this is the single
 * place that maps the parsed shape onto the Fetch standard's constraints.
 *
 * `parseHttpResponse` transparently skips 1xx interim heads, so anything
 * reaching this function should already be a final 2xx..5xx response.
 */
export const toWebResponse = (raw: RawHttpResponse): Response => {
  if (raw.status < 200 || raw.status > 599) {
    // Web Response only models the 200..599 final-status range. A 1xx
    // slipped through is a programmer error inside this package, not an
    // upstream-shaped failure — but the protocol-error class is still the
    // right surface for the caller.
    throw new HttpProtocolError(
      `status ${raw.status} is outside the Web Response constructible range 200..599`,
      'BAD_STATUS_LINE',
      { rfc: 'WHATWG Fetch §response-class' },
    );
  }
  // RFC 9110 §15.3.5 + §15.4.5: 204 No Content and 304 Not Modified MUST
  // NOT carry a body. The Web Response constructor also refuses a non-null
  // body for these statuses, so we cancel the body stream (in case the
  // parser fell back to until-EOF framing on a misbehaving upstream) and
  // construct with `null`.
  if (raw.status === 204 || raw.status === 304) {
    raw.body.cancel().catch(() => {});
    return new Response(null, { status: raw.status, headers: raw.headers });
  }
  return new Response(raw.body, { status: raw.status, headers: raw.headers });
};

/**
 * Parse an HTTP/1.1 response off a byte-stream reader. Returns a
 * wire-faithful struct rather than a Web `Response`: Response rejects 1xx
 * and refuses to carry a body for 204/304, but those are legal on the
 * wire. Bridge to a Response with {@link toWebResponse} when the caller
 * wants one.
 *
 * 1xx interim heads (100 Continue, 103 Early Hints, …) are read and
 * discarded transparently — RFC 9112 §6 mandates no body on a 1xx, so any
 * subsequent bytes are the next response head, which we re-parse on the
 * spot. The returned struct is always a non-1xx final response.
 */
export const parseHttpResponse = async (readable: ReadableStream<Uint8Array>): Promise<RawHttpResponse> => {
  const reader = readable.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  while (true) {
    const result = await readResponseHead(reader, buffer);
    buffer = result.remainder;
    if (result.status >= 100 && result.status < 200) {
      // Interim response: no body to frame, no headers to surface. The
      // remainder bytes belong to the next response; loop back into
      // head-parsing with them already buffered.
      continue;
    }
    return finalizeResponse(reader, result);
  }
};

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Headers;
  rawContentLengths: string[];
  rawTransferEncodings: string[];
  remainder: Uint8Array;
}

const readResponseHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  preBuffered: Uint8Array,
): Promise<ResponseHead> => {
  let buffer = preBuffered;

  // Cap accumulation so a misbehaving upstream that streams headers
  // forever can't exhaust the runtime's heap. 64 KiB is two orders of
  // magnitude over any sane response-header block.
  const HEADER_BUFFER_CAP = 64 * 1024;
  let headerEnd = findDoubleCrlf(buffer);
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

  // RFC 9112 §5: the header section MUST be ASCII. Reject any byte ≥ 0x80
  // up front — TextDecoder fatal-UTF-8 alone would accept valid UTF-8
  // sequences like 0xc3 0xa9 ("é") that the spec forbids in the header
  // section. The fatal decoder still catches invalid UTF-8 (lone 0xff)
  // post-scan, which keeps the message helpful on garbage bytes too.
  for (let i = 0; i < headerBytes.byteLength; i++) {
    if (headerBytes[i]! >= 0x80) {
      throw new HttpProtocolError(
        `non-ASCII byte 0x${headerBytes[i]!.toString(16).padStart(2, '0')} at offset ${i} in response headers`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
  }
  let headerText: string;
  try {
    headerText = ASCII_DECODER.decode(headerBytes);
  } catch (cause) {
    throw new HttpProtocolError(
      'invalid byte sequence in response headers',
      'BAD_HEADERS',
      { cause, rfc: 'RFC 9112 §5' },
    );
  }
  const lines = headerText.split('\r\n');
  const statusLine = lines.shift()!;
  // RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
  // Two distinct issues to call out separately for a useful error message:
  // (1) the line MUST start with HTTP/1.0 or HTTP/1.1 — llhttp dispatches
  //     HTTP/RTSP/ICE separately, so we surface anything that even begins
  //     `HTTP/` but isn't a supported version with a precise message.
  // (2) the second SP after the status code MUST be followed by a non-SP
  //     reason byte (or the line MUST end immediately — RFC 7230 erratum
  //     4087 permits an empty reason). A double SP between code and reason
  //     would silently absorb the extra SP into the reason in lenient
  //     parsers; llhttp's strict mode rejects it.
  if (!statusLine.startsWith('HTTP/')) {
    throw new HttpProtocolError(
      `status line does not begin with HTTP/: ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
  const m = /^HTTP\/(1\.[01]) (\d{3}) (\S.*|)$/.exec(statusLine);
  if (!m) {
    throw new HttpProtocolError(
      `bad status line: ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
  const status = parseInt(m[2]!, 10);
  const statusText = m[3]!;

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
    // RFC 9110 §5.5: field-content = field-vchar / SP / HTAB / obs-fold,
    // field-vchar = VCHAR / obs-text. After the §5 ASCII-only check above
    // strips obs-text, valid bytes inside a field value are HTAB (0x09),
    // SP (0x20), and VCHAR (0x21-0x7E). Anything else — NUL, the rest of
    // the C0 control set (0x01-0x08, 0x0B-0x1F; CR/LF already split the
    // line), and DEL (0x7F) — violates the grammar and points at either a
    // smuggling shape (CR/LF/NUL) or a transport-level garbage byte.
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x20 && c !== 0x09) {
        throw new HttpProtocolError(
          `invalid control byte 0x${c.toString(16).padStart(2, '0')} in header value for ${JSON.stringify(name)}`,
          'BAD_HEADERS',
          { rfc: 'RFC 9110 §5.5' },
        );
      }
      if (c === 0x7f) {
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

  return { status, statusText, headers: respHeaders, rawContentLengths, rawTransferEncodings, remainder };
};

const finalizeResponse = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: ResponseHead,
): RawHttpResponse => {
  const { status, statusText, headers, rawContentLengths, rawTransferEncodings, remainder } = head;

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
    headers.delete('transfer-encoding');
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

  return { status, statusText, headers, body };
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
            // Bound the unconsumed buffer + already-consumed lines against
            // the cap, rather than accumulating buf.byteLength per iteration
            // (which double-counts the same bytes on every drip-fed read and
            // collapses the effective cap to O(sqrt(MAX_TRAILERS_BYTES))).
            if (trailerBytesSeen + buf.byteLength > MAX_TRAILERS_BYTES) {
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
