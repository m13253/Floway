// Tiny byte-buffer primitives used by the HTTP/1.1 framing layer.
// Buffers come in from a transport-owned ReadableStream — those buffers may
// be pooled or reused by the runtime (most visibly on Node), so anything we
// enqueue downstream or retain past the next read needs to own its memory.
//
// These helpers stay internal to @floway-dev/http: they are not exported
// from the package surface. Every framing module in this package consumes
// them through here.

/**
 * Allocate a fresh ArrayBuffer-backed Uint8Array and copy `u` into it.
 * Detaches the resulting buffer from any transport-owned backing storage
 * so the consumer can hold or mutate it safely.
 */
export const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
};

/**
 * Concatenate two byte buffers into a freshly-allocated ArrayBuffer-backed
 * Uint8Array. The empty-input branches go through `copy()` so the returned
 * buffer is always detached from the inputs' backing storage — accumulators
 * (`buf = concat(buf, value)` starting from a zero-length buf) can therefore
 * hold the result past the next transport read without risking aliasing.
 */
export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (a.byteLength === 0) return copy(b);
  if (b.byteLength === 0) return copy(a);
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};

/**
 * Locate a CR/LF/CR/LF sequence — the HTTP/1.1 header-section terminator
 * (RFC 9112 §2.2). Returns the index of the first CR, or -1 if the buffer
 * doesn't contain a full terminator yet.
 */
export const findDoubleCrlf = (buf: Uint8Array): number => {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
};
