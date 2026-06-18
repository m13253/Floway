import { describe, expect, test } from 'vitest';

import { generateClaudeCodePkce } from './pkce.ts';

describe('generateClaudeCodePkce', () => {
  test('produces a verifier of expected length and url-safe alphabet', async () => {
    const { verifier } = await generateClaudeCodePkce();
    // 32 bytes base64url-encoded with no padding → 43 chars.
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('produces a challenge that is sha256(verifier) in base64url, length 43', async () => {
    const { verifier, challenge } = await generateClaudeCodePkce();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const expected = expectedB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });

  test('successive calls yield different verifiers', async () => {
    const a = await generateClaudeCodePkce();
    const b = await generateClaudeCodePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
