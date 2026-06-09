// Shared HTTP/1.1 grammar primitives reused by the parser, the chunked
// decoder, and the request-side validators in fetch-on-stream. Lives one
// level under those modules so the framing files don't have to import each
// other (the parser ↔ chunked dependency would otherwise be circular) and
// so the request- and response-side TCHAR check can't drift apart.

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
export const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 9112 §5 forbids any non-ASCII byte in the header section, so the
// per-response parser byte-scans for ≥ 0x80 up front and only feeds
// guaranteed-ASCII bytes here. Module-scope so neither the parser nor the
// chunked decoder allocates a fresh decoder per response. The chunked
// decoder reuses the same instance — its inputs are bounded to the 1 KiB
// chunk-size-line cap and the only field actually parsed is the pre-`;`
// hex prefix.
export const ASCII_DECODER = new TextDecoder();
