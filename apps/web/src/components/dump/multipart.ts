// Render a multipart/form-data body as readable text. Binary parts collapse
// to a single `[binary, N bytes, content-type=…]` marker so they do not blow
// up the dump dashboard, while the surrounding form structure (boundary
// markers, per-part headers, text fields) stays human-legible. The shape
// preserves the wire layout — operators can paste the rendered text into a
// docs note and still recognize it as multipart.

const TEXT_CONTENT_TYPE_RE = /^(text\/|application\/(json|x-?www-form-urlencoded|javascript|xml|xhtml\+xml|vnd\.api\+json)|.*\+json|.*\+xml)/i;

const isTextContentType = (ct: string): boolean => TEXT_CONTENT_TYPE_RE.test(ct.split(';')[0]!.trim());

const extractBoundary = (contentType: string): string | null => {
  // boundary= can be quoted (`boundary="abc"`) or bare (`boundary=abc`). The
  // RFC allows a fairly wide character set; trust the upstream parser to
  // round-trip it.
  const match = /;\s*boundary=("([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Linear scan for an exact byte sequence — boundaries are short (≤70 bytes)
// and most multipart bodies hold a handful of parts, so the naive scan is
// fine; bringing in a search library or building an indexer is overkill.
const indexOfSeq = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

// Wire-format-style base64 wrapping (76 chars per line, the MIME default
// in RFC 2045). Keeps a 2 MB PNG from rendering as one infinitely-wide
// line and matches what a `Content-Transfer-Encoding: base64` body would
// look like on a real HTTP wire trace.
const wrapBase64 = (s: string, width = 76): string => {
  if (s.length <= width) return s;
  const out: string[] = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out.join('\n');
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

interface ParsedPart {
  rawHeaders: string;
  bodyBytes: Uint8Array;
  contentType: string;
}

const splitPartHeaderAndBody = (part: Uint8Array): ParsedPart | null => {
  // Header / body separator is the first `\r\n\r\n`. CRLF is required by
  // RFC 7578 — LF-only is malformed and we let it surface as `null` so the
  // caller falls back to rendering the whole body as a single binary blob.
  const sep = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
  const idx = indexOfSeq(part, sep, 0);
  if (idx < 0) return null;
  const rawHeaders = decodeUtf8(part.slice(0, idx));
  const bodyBytes = part.slice(idx + sep.length);
  let contentType = '';
  for (const line of rawHeaders.split(/\r\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === 'content-type') {
      contentType = line.slice(colon + 1).trim();
      break;
    }
  }
  return { rawHeaders, bodyBytes, contentType };
};

// Render the parsed part with its headers verbatim plus either the decoded
// body text or a `[binary, N bytes, …]` placeholder followed by the part's
// own base64. The base64 keeps the binary payload visible in the dump so
// no information is lost; the wire-text Copy button on the section copies
// the entire raw multipart bytes (base64), so the rendered text is for
// reading only, not for replay.
const renderPart = (part: ParsedPart): string => {
  const headerBlock = part.rawHeaders.endsWith('\r\n') ? part.rawHeaders : `${part.rawHeaders}\r\n`;
  if (part.bodyBytes.length === 0) return `${headerBlock}\r\n`;
  if (isTextContentType(part.contentType) || part.contentType === '') {
    // Empty content-type is the RFC default for form-data text fields.
    const decoded = decodeUtf8(part.bodyBytes);
    return `${headerBlock}\r\n${decoded}`;
  }
  const ctTag = part.contentType ? `, content-type=${part.contentType}` : '';
  const placeholder = `[binary, ${part.bodyBytes.length} bytes${ctTag}]`;
  const base64 = wrapBase64(bytesToBase64(part.bodyBytes));
  return `${headerBlock}\r\n${placeholder}\r\n${base64}`;
};

export interface MultipartRendered {
  text: string;
  partCount: number;
  binaryPartCount: number;
}

// Parse a captured multipart body (base64) and pretty-print it. Returns
// null when the content-type carries no boundary parameter or the body is
// not a well-formed multipart payload — the caller decides whether to fall
// back to raw rendering.
export const renderMultipart = (b64: string, contentType: string): MultipartRendered | null => {
  const boundary = extractBoundary(contentType);
  if (boundary === null) return null;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return null;
  }

  const encoder = new TextEncoder();
  const delim = encoder.encode(`--${boundary}`);
  // Each part starts with `--<boundary>` on its own line. Locate every
  // delimiter occurrence; the slice between consecutive delimiters is one
  // part (with its leading `\r\n` and trailing `\r\n` trimmed).
  const positions: number[] = [];
  let cursor = indexOfSeq(bytes, delim, 0);
  while (cursor >= 0) {
    positions.push(cursor);
    cursor = indexOfSeq(bytes, delim, cursor + delim.length);
  }
  if (positions.length < 2) return null;

  const parts: ParsedPart[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i]! + delim.length;
    // The terminating delimiter ends with `--`; everything past it is the
    // multipart epilogue (usually empty). Stop processing parts when we
    // see the close-delimiter.
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break;
    const end = positions[i + 1]!;
    // Trim the leading CRLF after `--boundary` and the trailing CRLF
    // before the next `--boundary`.
    let bodyStart = start;
    if (bytes[bodyStart] === 0x0d && bytes[bodyStart + 1] === 0x0a) bodyStart += 2;
    let bodyEnd = end;
    if (bodyEnd >= 2 && bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const partBytes = bytes.slice(bodyStart, bodyEnd);
    const parsed = splitPartHeaderAndBody(partBytes);
    if (parsed === null) return null;
    parts.push(parsed);
  }
  if (parts.length === 0) return null;

  const renderedParts = parts.map(renderPart);
  const text = `--${boundary}\r\n${renderedParts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
  const binaryPartCount = parts.filter(p => !isTextContentType(p.contentType) && p.contentType !== '').length;
  return { text, partCount: parts.length, binaryPartCount };
};
