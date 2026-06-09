// Run an HTTP/1.1 request over an already-established duplex byte stream.
// Used both for native sockets that expose readable/writable directly and
// for our userspace-TLS-wrapped streams.

import { HttpProtocolError } from './errors.ts';
import { TCHAR } from './grammar.ts';
import { parseHttpResponse, toWebResponse } from './parser.ts';
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
