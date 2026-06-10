// Shared HTTP/1.1 grammar primitives. Lives one level under the framing
// modules so they don't have to import each other (the parser ↔ chunked
// dependency would otherwise be circular) and so the request- and
// response-side TCHAR check can't drift apart.

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
export const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 9112 §5 forbids any non-ASCII byte in the header section, so the
// parser and ws-upgrade pre-scan their header bytes for ≥ 0x80 before
// decoding through this instance. Module-scope so we never allocate a
// fresh decoder per request/response. The chunked decoder reuses the same
// instance without an up-front pre-scan — its inputs are bounded to the
// 1 KiB chunk-size-line cap and the only field actually parsed is the
// pre-`;` hex prefix, which the regex enforces.
export const ASCII_DECODER = new TextDecoder();
