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

/**
 * UTF-8-encode an ASCII string. Equivalent to `new TextEncoder().encode(s)`
 * but short enough to use inline in HKDF info / context-binding literals
 * without forcing each caller to keep its own encoder around.
 */
export const asciiBytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Fill a fresh `n`-byte buffer from the Web Crypto CSPRNG. */
export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
};

/**
 * Parse a hex string into bytes. Throws on odd length; the caller is
 * responsible for validating the character set up front when the input is
 * untrusted, since `parseInt('zz', 16)` returns NaN and the byte slot is
 * then written as 0.
 */
export const hexDecode = (s: string): Uint8Array<ArrayBuffer> => {
  if (s.length % 2 !== 0) throw new Error(`hex: odd length ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
