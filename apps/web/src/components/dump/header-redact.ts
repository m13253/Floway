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

// Fixed-width mask: do not leak the secret's length. Keep up to the last four
// characters so an operator can recognize *which* credential they're looking
// at without revealing the bulk of it. Short values get a tail-less mask —
// "the last four characters" of a three-character value would be the entire
// secret, so suppress the tail when the value is too short to suffix safely.
export const redactHeaderValue = (value: string): string => {
  if (value.length < 8) return '•'.repeat(8);
  return `${'•'.repeat(8)}${value.slice(-4)}`;
};
