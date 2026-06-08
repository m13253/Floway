import { gcm } from '@noble/ciphers/aes.js';
import { describe, expect, it } from 'vitest';

import { buildRealityAad, buildRealitySessionId, dialReality } from './reality.ts';
import { hexDecode } from '../bytes.ts';
import type { RealityProxyConfig } from '../proxy-config.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';
import type { DialTarget } from '../types.ts';

describe('buildRealitySessionId', () => {
  it('packs version, timestamp, and short id into 32 bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0x12345678, hexDecode('00112233445566aa'));
    expect(Array.from(sid.subarray(0, 4))).toEqual([25, 4, 30, 0x00]);
    expect(Array.from(sid.subarray(4, 8))).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(Array.from(sid.subarray(8, 16))).toEqual([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xaa]);
    // Bytes 16..31 left zero — Xray fills these with the AEAD ciphertext+tag.
    expect(Array.from(sid.subarray(16))).toEqual(new Array(16).fill(0));
  });

  it('rejects a short-id that is not exactly 8 bytes', () => {
    expect(() => buildRealitySessionId([25, 4, 30], 0, new Uint8Array(7))).toThrow(/shortId/);
    expect(() => buildRealitySessionId([25, 4, 30], 0, new Uint8Array(9))).toThrow(/shortId/);
  });
});

describe('buildRealityAad', () => {
  it('zeros the 32-byte session_id slot at offset 39', () => {
    const ch = new Uint8Array(200);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = (i * 37) & 0xff;

    const aad = buildRealityAad(ch);
    // Bytes outside [39, 71) are untouched.
    for (let i = 0; i < 39; i++) expect(aad[i]).toBe(ch[i]);
    for (let i = 71; i < ch.byteLength; i++) expect(aad[i]).toBe(ch[i]);
    // Bytes [39, 71) are zero.
    for (let i = 39; i < 71; i++) expect(aad[i]).toBe(0);
  });

  it('returns a fresh buffer rather than mutating the input', () => {
    const ch = new Uint8Array(200);
    ch[40] = 0xab;
    const aad = buildRealityAad(ch);
    expect(ch[40]).toBe(0xab);
    expect(aad[40]).toBe(0);
  });
});

describe('buildRealityAad — AEAD round trip', () => {
  it('a 16-byte plaintext sealed with AES-256-GCM under our AAD shape decrypts losslessly', () => {
    // Smoke test that the AAD-shape contract round-trips through AES-256-GCM,
    // independent of any TLS plumbing. If the AAD-zeroing layout ever changes,
    // this fails immediately.
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ch = new Uint8Array(120);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = i;
    const aad = buildRealityAad(ch);
    const sid = buildRealitySessionId([25, 4, 30], 0x66778899, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const sealed = gcm(key, nonce, aad).encrypt(sid.subarray(0, 16));
    expect(sealed.byteLength).toBe(32);
    const opened = gcm(key, nonce, aad).decrypt(sealed);
    expect(Array.from(opened)).toEqual(Array.from(sid.subarray(0, 16)));
  });
});

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const realityConfig = (overrides: Partial<RealityProxyConfig> = {}): RealityProxyConfig => ({
  kind: 'reality',
  uuid: '11111111-2222-3333-4444-555555555555',
  // 32 well-formed base64url bytes — overridden in the bad-pbk case below.
  publicKey: 'A'.repeat(43),
  fingerprint: 'chrome',
  serverName: 'www.cloudflare.com',
  host: 'h',
  port: 443,
  name: 'r',
  ...overrides,
});

describe('dialReality — pre-connect config validation', () => {
  // Wrap the decoder + length checks as ProxyDialError so a malformed config
  // doesn't fly past the gateway's `instanceof ProxyDialError` gate and kill
  // the rest of the fallback chain.
  it('rejects an unparseable pbk base64 string as a typed dial error', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ publicKey: '!!!not-base64!!!' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('invalid base64'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a pbk whose decoded length is not 32 bytes', async () => {
    const fake = makeFakeSocketDial();
    // Three base64 chars decode to only 2 bytes — not 32.
    await expect(
      dialReality(realityConfig({ publicKey: 'AAA' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('pubkey must be 32 bytes'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects an odd-length sid hex string as a typed dial error', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ shortId: 'abc' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('invalid hex'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a sid whose decoded length is not 8 bytes', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ shortId: 'aabb' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('shortId must be 8 bytes'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});
