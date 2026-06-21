// Sensitive-header redaction shared between the request-side and response-side
// header tables. Default-redacted headers are the obvious bearer-style
// credentials plus cookies and proxy auth — a leaked cookie value is just as
// bad as a leaked bearer token. `set-cookie` covers the response side: an
// upstream that sets a session cookie should not echo through the dashboard.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

export const isSensitiveHeader = (key: string): boolean => SENSITIVE_HEADERS.has(key.toLowerCase());

// Length-preserving mask. The visual mass of the original value carries one
// useful signal — "this is a 64-char token, not an 8-char one" — and erasing
// it makes every credential look identical. Keep the first and last
// `VISIBLE_PREFIX` / `VISIBLE_SUFFIX` characters so an operator can recognize
// the credential type from the prefix (`sk-ant-…`, `cgw-main-…`) and match
// the tail against their notes, and replace the middle with the same number
// of `•` as the original held. Anything `VISIBLE_PREFIX + VISIBLE_SUFFIX`
// chars or shorter has no "middle" — keeping any visible bytes at that
// length leaks the whole secret, so collapse to a same-length mask.
const VISIBLE_PREFIX = 8;
const VISIBLE_SUFFIX = 8;
const SAFE_MIN_LENGTH = VISIBLE_PREFIX + VISIBLE_SUFFIX;

export const redactHeaderValue = (value: string): string => {
  if (value.length <= SAFE_MIN_LENGTH) return '•'.repeat(value.length);
  return `${value.slice(0, VISIBLE_PREFIX)}${'•'.repeat(value.length - SAFE_MIN_LENGTH)}${value.slice(-VISIBLE_SUFFIX)}`;
};
