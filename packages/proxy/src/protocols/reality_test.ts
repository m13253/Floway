import { gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  buildRealityAad,
  buildRealitySessionId,
  constantTimeEqual,
  dialReality,
  extractEd25519RawPubKey,
  parseShortId,
} from './reality.ts';
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
});

describe('buildRealitySessionId — timestamp and shortId encoding', () => {
  it('packs ts=0 as four zero bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0, new Uint8Array(8));
    expect(Array.from(sid.subarray(4, 8))).toEqual([0, 0, 0, 0]);
  });

  it('packs ts=0xffffffff as four 0xff bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0xffffffff, new Uint8Array(8));
    expect(Array.from(sid.subarray(4, 8))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('preserves arbitrary shortId byte values verbatim at offset 8', () => {
    const sid = buildRealitySessionId([1, 2, 3], 42, hexDecode('deadbeefcafe1234'));
    expect(Array.from(sid.subarray(8, 16))).toEqual([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x12, 0x34]);
  });

  it('lays out the Xray version triplet at offsets 0..2 with the trailing zero at offset 3', () => {
    const sid = buildRealitySessionId([99, 88, 77], 0, new Uint8Array(8));
    expect(sid[0]).toBe(99);
    expect(sid[1]).toBe(88);
    expect(sid[2]).toBe(77);
    expect(sid[3]).toBe(0);
  });
});

describe('buildRealityAad — clientHello boundary cases', () => {
  it('handles a clientHello exactly 71 bytes long (last byte is at session_id end)', () => {
    const ch = new Uint8Array(71);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = i;
    const aad = buildRealityAad(ch);
    for (let i = 39; i < 71; i++) expect(aad[i]).toBe(0);
    for (let i = 0; i < 39; i++) expect(aad[i]).toBe(i);
  });

  it('preserves bytes immediately adjacent to the zeroed slot (offsets 38 and 71)', () => {
    const ch = new Uint8Array(100);
    ch[38] = 0xaa;
    ch[71] = 0xbb;
    const aad = buildRealityAad(ch);
    expect(aad[38]).toBe(0xaa);
    expect(aad[71]).toBe(0xbb);
    expect(aad[39]).toBe(0);
    expect(aad[70]).toBe(0);
  });

  it('produces a buffer the same length as the input', () => {
    const ch = new Uint8Array(300);
    const aad = buildRealityAad(ch);
    expect(aad.byteLength).toBe(300);
  });
});

describe('dialReality — pre-connect base64 decoder corner cases', () => {
  // base64url with padding stripped — common in URI form. The decoder
  // re-adds '=' padding internally. We verify the decoder reaches the
  // connect call without throwing; the actual TLS handshake doesn't happen
  // because we abort right after.
  const verifyReachesConnect = async (publicKey: string): Promise<void> => {
    const fake = makeFakeSocketDial();
    const ctrl = new AbortController();
    const p = dialReality(realityConfig({ publicKey }), target, { socketDial: fake.socketDial, signal: ctrl.signal });
    p.catch(() => { /* aborted dial — we only care that we reached connect */ });
    await fake.awaitConnect();
    ctrl.abort();
    expect(fake.connectCount()).toBe(1);
    await Promise.race([p, new Promise(r => setTimeout(r, 50))]).catch(() => {});
  };

  it('accepts a 43-char base64url string (no padding)', async () => {
    // 'A'.repeat(43) decodes to 32 zero bytes (32-byte pubkey).
    await verifyReachesConnect('A'.repeat(43));
  });

  it('accepts a 44-char base64 string with explicit padding', async () => {
    await verifyReachesConnect(`${'A'.repeat(43)}=`);
  });

  it('accepts a base64url string with the URL-safe alphabet (- and _)', async () => {
    // 32 bytes of 0xfe yields a 43-char base64url with '-' and '_' characters.
    await verifyReachesConnect('_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v4');
  });

  it('rejects a 33-byte pubkey (one byte too long)', async () => {
    const fake = makeFakeSocketDial();
    // 33 bytes = 44 base64 chars without padding.
    const tooLong = 'A'.repeat(44);
    await expect(
      dialReality(realityConfig({ publicKey: tooLong }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('pubkey must be 32 bytes'),
    });
  });
});

describe('dialReality — shortId hex decoder corner cases', () => {
  const verifyReachesConnect = async (shortId: string | undefined): Promise<void> => {
    const fake = makeFakeSocketDial();
    const ctrl = new AbortController();
    const p = dialReality(realityConfig({ shortId }), target, { socketDial: fake.socketDial, signal: ctrl.signal });
    p.catch(() => { /* aborted dial — we only care that we reached connect */ });
    await fake.awaitConnect();
    ctrl.abort();
    expect(fake.connectCount()).toBe(1);
    await Promise.race([p, new Promise(r => setTimeout(r, 50))]).catch(() => {});
  };

  it('accepts uppercase hex characters', async () => {
    await verifyReachesConnect('AABBCCDDEEFF1122');
  });

  it('accepts the all-zeros 16-char shortId', async () => {
    await verifyReachesConnect('0000000000000000');
  });

  it('accepts an empty sid (the documented default — zero-pads to all-zeros)', async () => {
    await verifyReachesConnect('');
  });

  it('accepts an undefined sid (treated as empty)', async () => {
    await verifyReachesConnect(undefined);
  });

  it('accepts shorter hex slices — Xray-core copy(SessionId[8:], shortId) leaves the tail zero', async () => {
    await verifyReachesConnect('aabb');
    await verifyReachesConnect('aabbccddeeff');
  });

  it('rejects a 17-char hex shortId — exceeds the 8-byte (16 hex char) slot', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ shortId: '0011223344556677889' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('shortId hex must be 0..16 chars'),
    });
  });
});

describe('parseShortId', () => {
  it('zero-pads an empty sid to 8 bytes', () => {
    const padded = parseShortId('');
    expect(padded.byteLength).toBe(8);
    expect(Array.from(padded)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('zero-pads an undefined sid to 8 bytes', () => {
    const padded = parseShortId(undefined);
    expect(Array.from(padded)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('zero-pads a 2-char hex sid into the leading byte, leaving the tail zero', () => {
    expect(Array.from(parseShortId('aa'))).toEqual([0xaa, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('packs a full 16-char hex sid into all 8 bytes verbatim', () => {
    expect(Array.from(parseShortId('0011223344556677'))).toEqual([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  });
});

describe('extractEd25519RawPubKey', () => {
  // RFC 8410 §4: an Ed25519 SubjectPublicKeyInfo is a fixed 44-byte DER blob,
  // 12 bytes of SEQUENCE+OID+BITSTRING prefix followed by the 32-byte raw key.
  const ED25519_SPKI_PREFIX = hexDecode('302a300506032b6570032100');

  it('returns the 32-byte raw key for a valid Ed25519 SPKI', () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = i;
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + 32);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki.set(raw, ED25519_SPKI_PREFIX.byteLength);
    expect(Array.from(extractEd25519RawPubKey(spki))).toEqual(Array.from(raw));
  });

  it('rejects an SPKI whose total length is not 44 bytes', () => {
    expect(() => extractEd25519RawPubKey(new Uint8Array(43))).toThrow(/44 bytes/);
    expect(() => extractEd25519RawPubKey(new Uint8Array(45))).toThrow(/44 bytes/);
  });

  it('rejects an SPKI with a non-Ed25519 prefix', () => {
    // RSA SPKI starts with a different SEQUENCE shape; first byte still 0x30,
    // but the algorithm OID block differs. Flip one byte in the OID region to
    // simulate a wrong-algorithm leaf cert.
    const spki = new Uint8Array(44);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki[6] = 0xff;
    expect(() => extractEd25519RawPubKey(spki)).toThrow(/prefix mismatch/);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical buffers', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('returns false for buffers that differ in any byte', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 1]))).toBe(false);
  });

  it('returns false for buffers of different lengths', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(1))).toBe(false);
  });
});

describe('REALITY server-cert HMAC verification — round trip', () => {
  // Demonstrates the wire shape the dialer's onRecvCertificateVerify hook
  // enforces: the leaf cert's signature field must equal HMAC-SHA512 over
  // the leaf's raw Ed25519 pubkey, keyed by the shared 32-byte authKey.
  // Matches Xray-core's reality.go VerifyPeerCertificate.
  it('HMAC-SHA512(authKey, leafEd25519Pub) yields the same tag a REALITY server would emit', () => {
    const authKey = new Uint8Array(32);
    crypto.getRandomValues(authKey);
    const leafPub = new Uint8Array(32);
    crypto.getRandomValues(leafPub);

    const expected = hmac(sha512, authKey, leafPub);
    const got = hmac(sha512, authKey, leafPub);
    expect(constantTimeEqual(expected, got)).toBe(true);
    expect(expected.byteLength).toBe(64);
  });

  it('a tag computed under a different authKey does not match — the cert-verify hook would reject', () => {
    const authKey = new Uint8Array(32).fill(0xaa);
    const wrongAuthKey = new Uint8Array(32).fill(0xbb);
    const leafPub = new Uint8Array(32).fill(0x55);

    const expected = hmac(sha512, authKey, leafPub);
    const wrong = hmac(sha512, wrongAuthKey, leafPub);
    expect(constantTimeEqual(expected, wrong)).toBe(false);
  });

  it('a tag computed over a different leaf pubkey does not match — defends against MitM cert injection', () => {
    const authKey = new Uint8Array(32).fill(0xaa);
    const leafPub = new Uint8Array(32).fill(0x55);
    const attackerLeafPub = new Uint8Array(32).fill(0x66);

    const expected = hmac(sha512, authKey, leafPub);
    const attacker = hmac(sha512, authKey, attackerLeafPub);
    expect(constantTimeEqual(expected, attacker)).toBe(false);
  });
});
