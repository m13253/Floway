// Tiny byte-buffer primitives shared across the proxy-protocol dialers.
// Buffers come in from a transport-owned ReadableStream — those buffers may
// be pooled or reused by the runtime (most visibly on Node), so anything we
// enqueue downstream or retain past the next read needs to own its memory.

import { ProxyDialError } from './errors.ts';

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
 * Parse a hex string into bytes. Throws on odd length or any non-hex
 * character — `parseInt('zz', 16)` returns NaN which would otherwise
 * silently write the byte slot as 0 and let a typo through wire framing.
 */
export const hexDecode = (s: string): Uint8Array<ArrayBuffer> => {
  if (s.length % 2 !== 0) throw new Error(`hex: odd length ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    const hi = hexNibble(s.charCodeAt(i * 2));
    const lo = hexNibble(s.charCodeAt(i * 2 + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
};

const hexNibble = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;       // '0'..'9'
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;  // 'a'..'f'
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;  // 'A'..'F'
  throw new Error(`hex: non-hex character 0x${code.toString(16)}`);
};

/**
 * Locate a CR/LF/CR/LF sequence — the HTTP/1.1 header-section terminator
 * (RFC 9112 §2.2). Returns the index of the first CR, or -1 if the buffer
 * doesn't contain a full terminator yet. Used by the CONNECT-response peel
 * in the HTTP proxy dialer.
 */
export const findDoubleCrlf = (buf: Uint8Array): number => {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
};

/**
 * Base64-encode a raw byte buffer. `btoa` requires a binary-string input
 * (one code-unit per byte), so we map each byte to its corresponding
 * Latin-1 code unit via `String.fromCharCode` before calling btoa. Used
 * for HTTP CONNECT Basic-auth where RFC 7617 §2.1 mandates UTF-8 bytes —
 * the caller encodes credentials to UTF-8 with TextEncoder, then base64s
 * those bytes (NOT the JS string code units of the original credentials,
 * which would emit Latin-1 bytes and crash on code points > U+00FF).
 */
export const base64EncodeBytes = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

/**
 * Parse an IPv4 dotted-quad literal into 4 octets, or return null if `s`
 * isn't a literal IPv4. Strict: each component must be a decimal in
 * 0..255 with no leading zeros (the "no leading zeros" rule prevents
 * "0123" being read as 123 — some resolvers interpret leading zeros as
 * octal). Used to switch a SOCKS-family address to ATYP=0x01.
 */
export const parseIpv4Literal = (s: string): Uint8Array | null => {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return null;
  const parts = s.split('.');
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (p.length > 1 && p.startsWith('0')) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
};

/**
 * Parse an IPv6 literal (with optional `[...]` brackets) into 16 octets,
 * or return null if `s` isn't a literal IPv6. Defers to the WHATWG `URL`
 * parser, which has a fully spec-compliant IPv6 grammar and handles
 * `::`, IPv4-mapped suffixes (`::ffff:1.2.3.4`), and the all-the-shapes
 * cases that a regex couldn't cover.
 */
export const parseIpv6Literal = (s: string): Uint8Array | null => {
  // `URL` reads bracketed IPv6 hostnames. Strip the brackets if the
  // caller passed them in literal form; add them otherwise. A plain IPv4
  // would parse too but with a colon-less hostname — we filter that out
  // with the colon check.
  if (!s.includes(':')) return null;
  const unbracketed = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  let url: URL;
  try {
    url = new URL(`http://[${unbracketed}]/`);
  } catch {
    return null;
  }
  // `url.hostname` is normalised — `[::1]` → `[::1]`. Strip the brackets,
  // then expand to 16 octets via the canonical-form regex.
  const norm = url.hostname.slice(1, -1);
  return ipv6StringToBytes(norm);
};

const ipv6StringToBytes = (s: string): Uint8Array | null => {
  // Split at `::` once; each half is a sequence of hex groups.
  const [left, right] = s.includes('::') ? s.split('::', 2) as [string, string] : [s, ''];
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  // IPv4-mapped suffix support: the last group can be a dotted-quad.
  const tailIpv4 = rightParts.length > 0 && rightParts[rightParts.length - 1]!.includes('.')
    ? parseIpv4Literal(rightParts.pop()!)
    : leftParts.length > 0 && leftParts[leftParts.length - 1]!.includes('.')
      ? parseIpv4Literal(leftParts.pop()!)
      : null;
  const groups: number[] = [];
  for (const p of leftParts) groups.push(parseInt(p, 16));
  const zerosNeeded = 8 - leftParts.length - rightParts.length - (tailIpv4 ? 2 : 0);
  if (zerosNeeded < 0) return null;
  for (let i = 0; i < zerosNeeded; i++) groups.push(0);
  for (const p of rightParts) groups.push(parseInt(p, 16));
  if (groups.length !== (tailIpv4 ? 6 : 8)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    out[i * 2] = (groups[i]! >> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  if (tailIpv4) {
    out[12] = tailIpv4[0]!;
    out[13] = tailIpv4[1]!;
    out[14] = tailIpv4[2]!;
    out[15] = tailIpv4[3]!;
  }
  return out;
};

/**
 * ATYP byte triplet for a proxy protocol's SOCKS-style address frame.
 * SOCKS5 / Shadowsocks / Shadowsocks-2022 / Trojan all share the
 * 0x01/0x03/0x04 numbering; VLESS uses 0x01/0x02/0x03 instead. The
 * dialers thread their own values into `encodeAtypAddress` so the
 * IP-literal / domain discrimination + non-ASCII reject + 255-byte cap
 * stays in one place.
 */
export interface AtypBytes {
  v4: number;
  domain: number;
  v6: number;
}

/**
 * Encode `host` as `[ATYP][addr-bytes]` for a SOCKS-style proxy frame.
 *
 * Literal IPv4 / IPv6 targets emit raw octets (4 / 16 bytes) so the
 * upstream doesn't have to re-parse a string into an address — the wire
 * shape sing-box / Xray-core / shadowsocks-rust all send for literal
 * targets. Domain hostnames take the length-prefixed `0x03`/`0x02` path.
 *
 * Non-ASCII hostnames are rejected up-front: per `DialTarget.host`'s
 * contract, callers MUST punycode IDN labels before reaching the dial
 * layer, and a UTF-8 / Latin-1 muddle in a length-prefixed wire frame
 * silently corrupts the address on the far side. `protocolLabel` flows
 * into the thrown ProxyDialError so the operator sees which protocol
 * rejected the host. Domain names over 255 bytes are similarly rejected
 * — the 1-byte length prefix can't address them.
 */
export const encodeAtypAddress = (
  host: string,
  atyp: AtypBytes,
  protocolLabel: string,
): Uint8Array<ArrayBuffer> => {
  // Strip the optional IPv6 brackets so callers can pass either
  // `2001:db8::1` or `[2001:db8::1]`.
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = parseIpv4Literal(host);
  if (v4) {
    const out = new Uint8Array(1 + 4);
    out[0] = atyp.v4;
    out.set(v4, 1);
    return out;
  }
  const v6 = parseIpv6Literal(unbracketed);
  if (v6) {
    const out = new Uint8Array(1 + 16);
    out[0] = atyp.v6;
    out.set(v6, 1);
    return out;
  }
  for (let i = 0; i < host.length; i++) {
    if (host.charCodeAt(i) > 0x7f) {
      throw new ProxyDialError(
        `${protocolLabel} target host must be ASCII (punycode IDN before dial): ${host}`,
        'proxy-handshake',
      );
    }
  }
  const dom = new TextEncoder().encode(host);
  if (dom.byteLength > 255) {
    throw new ProxyDialError(
      `${protocolLabel}: hostname too long (${dom.byteLength} bytes; ATYP domain is 1-byte length-prefixed)`,
      'proxy-handshake',
    );
  }
  const out = new Uint8Array(1 + 1 + dom.byteLength);
  out[0] = atyp.domain;
  out[1] = dom.byteLength;
  out.set(dom, 2);
  return out;
};
