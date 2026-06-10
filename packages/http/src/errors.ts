// Errors raised when an HTTP/1.1 message is malformed or smuggling-shaped.
//
// fetchOnStream, the response/chunked parsers, and wsUpgradeAndFrame throw
// HttpProtocolError for everything that's an HTTP-layer framing problem
// (bad status line, multiple Content-Length, chunked size garbage, header
// validation, WS handshake / frame violations, control-frame caps,
// fragmented-message size caps, …). Transport errors propagate as the
// underlying error.

/**
 * Stable discriminator for an HttpProtocolError. Lets callers branch on
 * a class of failure (smuggling, header-shape, body-framing, DoS cap)
 * without parsing the human-readable `message`.
 */
export type HttpProtocolErrorCode =
  | 'BAD_STATUS_LINE'
  | 'BAD_HEADERS'
  | 'OBS_FOLD'
  | 'CL_AND_TE'
  | 'MULTIPLE_CL'
  | 'BAD_CL'
  | 'TE_NOT_CHUNKED'
  | 'TE_DOUBLE_CHUNKED'
  | 'CHUNK_BAD_SIZE'
  | 'CHUNK_TOO_LONG'
  | 'TRAILERS_TOO_LONG'
  | 'TOO_MANY_HEADERS'
  | 'HEADER_BUFFER_OVERFLOW'
  | 'WS_MESSAGE_TOO_LARGE'
  | 'EOF'
  | 'TRAILING_BODY_BYTES'
  | 'HEAD_REQUEST_REJECTED';

export class HttpProtocolError extends Error {
  override readonly name = 'HttpProtocolError';
  readonly code: HttpProtocolErrorCode;
  /** RFC reference whose grammar / framing rule the violation maps to. */
  readonly rfc?: string;

  constructor(message: string, code: HttpProtocolErrorCode, opts?: { cause?: unknown; rfc?: string }) {
    super(message, opts);
    this.code = code;
    this.rfc = opts?.rfc;
  }
}
