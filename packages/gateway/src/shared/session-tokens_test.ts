import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';

import { extractSessionToken, generateSessionToken } from './session-tokens.ts';

describe('session-tokens', () => {
  test('generateSessionToken returns 64 lowercase hex characters', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('successive tokens differ', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });

  test('extractSessionToken reads the x-floway-session header', async () => {
    const app = new Hono().get('/probe', c => c.json({ token: extractSessionToken(c) }));
    const res = await app.request('/probe', { headers: { 'x-floway-session': 'abc' } });
    expect(await res.json()).toEqual({ token: 'abc' });
  });

  test('extractSessionToken returns null when header is absent', async () => {
    const app = new Hono().get('/probe', c => c.json({ token: extractSessionToken(c) }));
    const res = await app.request('/probe');
    expect(await res.json()).toEqual({ token: null });
  });
});
