// Shared HTTP/1.1 grammar primitives. Lives one level under the framing
// modules so they don't have to import each other (the parser ↔ chunked
// dependency would otherwise be circular) and so the request- and
// response-side TCHAR check can't drift apart.

import { HttpProtocolError } from './errors.ts';

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
export const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Module-scope so we never allocate a fresh decoder per request/response.
// The chunked decoder reuses the same instance without the §5 ≥0x80
// pre-scan that decodeAsciiHeaderSection performs — its inputs are
// bounded to the 1 KiB chunk-size-line cap and the only field actually
// parsed is the pre-`;` hex prefix, which the regex enforces.
export const ASCII_DECODER = new TextDecoder();

// RFC 9112 §5 forbids any non-ASCII byte in the header section. Reject
// ≥ 0x80 before decoding — TextDecoder fatal-UTF-8 alone would accept
// valid UTF-8 sequences like 0xc3 0xa9 ("é") that the spec forbids in
// the header section. Shared by parser.ts and ws-upgrade.ts so the two
// response-side header framings can't drift apart.
export const decodeAsciiHeaderSection = (bytes: Uint8Array, context: string): string => {
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i]! >= 0x80) {
      throw new HttpProtocolError(
        `non-ASCII byte 0x${bytes[i]!.toString(16).padStart(2, '0')} at offset ${i} in ${context}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
  }
  return ASCII_DECODER.decode(bytes);
};

// RFC 9110 §5.6.3: OWS = *( SP / HTAB ). Strip from both ends of a
// field-value. Shared by parser.ts and ws-upgrade.ts. Wrapped in a
// helper rather than exporting the bare `/g`-flag regex because a
// module-scope `/g` regex carries `lastIndex` and would become a
// footgun if anyone later switched to `.test`/`.exec`.
export const trimFieldValueOws = (value: string): string => value.replace(/^[\t ]+|[\t ]+$/g, '');

// RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
// Shared by parser.ts, ws-upgrade.ts, and the proxy package's CONNECT
// peel so the three response-side framings can't drift apart. The
// version group is non-capturing — no caller reads it — so capture
// indices are status=m[1], reason=m[2]. The reason alternation
// `(\S.*|)` permits an empty reason (RFC 7230 erratum 4087) while
// forbidding a leading SP, which would otherwise be silently absorbed
// from a double SP between code and reason.
export const STATUS_LINE = /^HTTP\/(?:1\.[01]) (\d{3}) (\S.*|)$/;
