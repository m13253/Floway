// Tiny byte-buffer primitives shared across the HTTP framing layer and the
// proxy-protocol dialers. Both code paths handle bytes that come in from a
// transport-owned ReadableStream — those buffers may be pooled or reused by
// the runtime (most visibly on Node), so anything we enqueue downstream or
// retain past the next read needs to own its memory.

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
 * Uint8Array. Short-circuits the empty-input cases to a single `copy()` so
 * a typical accumulator (`buf = concat(buf, value)` starting from a
 * zero-length buf) doesn't pay for a redundant double-copy on the first
 * read.
 */
export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (a.byteLength === 0) return copy(b);
  if (b.byteLength === 0) return copy(a);
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};
