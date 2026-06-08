// @floway-dev/http — HTTP/1.1 over a duplex byte stream + userspace TLS.
//
// This package speaks HTTP/1.1 against any duplex transport — a raw TCP
// socket, a userspace-TLS-wrapped stream, a CONNECT-tunnelled stream, etc.
// It has no opinion on how the duplex got there; the caller hands one in.
//
// It also ships a userspace TLS adapter for runtimes whose native
// `Socket.startTls()` cannot wrap a stream that has already exchanged
// plain bytes, and for protocols that need full control over TLS record
// framing.

export type { DuplexStream, HttpRequest, RawHttpResponse } from './types.ts';

export { fetchOnStream, parseHttpResponse, toWebResponse, decodeChunked } from './fetch-on-stream.ts';
export type { FetchOnStreamOptions } from './fetch-on-stream.ts';

export { userspaceTls } from './tls.ts';
export type { UserspaceTlsOptions, TlsStream } from './tls.ts';

export { HttpProtocolError } from './errors.ts';
export type { HttpProtocolErrorCode } from './errors.ts';
