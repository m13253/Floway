// Errors raised when an HTTP/1.1 response is malformed or smuggling-shaped.
//
// fetchOnStream throws HttpProtocolError for everything that's an HTTP-layer
// framing problem (bad status line, multiple Content-Length, chunked size
// line garbage, etc.). Transport errors propagate as the underlying error.

export class HttpProtocolError extends Error {
  override readonly name = 'HttpProtocolError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
