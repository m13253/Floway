import { expect, test } from 'vitest';

import { isSensitiveHeader, redactHeaderValue } from './header-redact.ts';

test('isSensitiveHeader matches the same set on both request and response sides', () => {
  // The list is shared by the request-side table and the response-side
  // table — `set-cookie` showing up as a response header must be redacted
  // just like `cookie` on the request side, otherwise an upstream that sets
  // a session cookie leaks through the dashboard.
  for (const name of ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-goog-api-key']) {
    expect(isSensitiveHeader(name)).toBe(true);
    expect(isSensitiveHeader(name.toUpperCase())).toBe(true);
  }
});

test('isSensitiveHeader leaves non-credential headers untouched', () => {
  for (const name of ['content-type', 'content-length', 'x-trace-id', 'date']) {
    expect(isSensitiveHeader(name)).toBe(false);
  }
});

test('redactHeaderValue preserves last four characters behind a fixed-width mask', () => {
  expect(redactHeaderValue('sk-abcdef1234')).toBe('••••••••1234');
  // Values shorter than the safe tail threshold collapse to a tail-less mask
  // so the secret isn't echoed back wholesale (e.g. a three-char value would
  // otherwise appear verbatim after the mask).
  expect(redactHeaderValue('abc')).toBe('••••••••');
  expect(redactHeaderValue('1234567')).toBe('••••••••');
});
