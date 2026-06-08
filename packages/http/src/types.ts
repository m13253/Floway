// Public types for HTTP/1.1 over a duplex byte stream.
//
// This package speaks HTTP/1.1 against any duplex transport — a raw TCP
// socket, a userspace-TLS-wrapped stream, a CONNECT-tunnelled stream, etc.
// It has no opinion on how the duplex got there; the caller hands one in.

/**
 * A duplex byte transport. Both halves are owned by the caller; the
 * primitives in this package borrow them through getReader/getWriter and
 * release the locks on every teardown path.
 */
export interface DuplexStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * HTTP/1.1 request shape, transport-agnostic. The caller has already
 * dialed and (if needed) TLS-wrapped the stream — this package only
 * serializes the request and parses the response.
 *
 * `headers` MUST include `Host` (we do NOT synthesize one from the
 * transport; this package has no knowledge of the dial target).
 *
 * Caller-supplied `Content-Length`, `Transfer-Encoding`, and
 * `Connection` are stripped: the buffered body's exact length is the
 * source of truth, and this layer is one-shot per duplex (it always
 * emits `Connection: close`) so a `keep-alive` would mislead the server
 * into reusing a transport we plan to tear down.
 */
export interface HttpRequest {
  method: string;
  /** Path + query string, e.g. `/v1/messages?stream=true`. */
  path: string;
  headers: Record<string, string>;
  /** Optional buffered body. Streaming bodies are not supported. */
  body?: Uint8Array;
}
