import { gcm } from '@noble/ciphers/aes.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { describe, expect, it } from 'vitest';

import type { Shadowsocks2022ProxyConfig } from '../proxy-config.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';
import type { DialTarget } from '../types.ts';
import { buildSs2022RequestHeader, dialShadowsocks2022 } from './shadowsocks-2022.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

// 16-byte PSK encoded as base64 — required key length for blake3-aes-128-gcm.
const PSK_BYTES = new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1));
const PSK_B64 = btoa(String.fromCharCode(...PSK_BYTES));

const config = (overrides: Partial<Shadowsocks2022ProxyConfig> = {}): Shadowsocks2022ProxyConfig => ({
  kind: 'ss2022',
  method: '2022-blake3-aes-128-gcm',
  passwordBase64: PSK_B64,
  host: 'proxy.example',
  port: 8388,
  name: 'ss2022',
  ...overrides,
});

const SUBKEY_CONTEXT = new TextEncoder().encode('shadowsocks 2022 session subkey');

describe('buildSs2022RequestHeader', () => {
  it('encodes ATYP=0x03 | dom_len | dom | port BE | padlen=16 | 16-byte pad', () => {
    const h = buildSs2022RequestHeader('api.openai.com', 443);
    let off = 0;
    expect(h[off++]).toBe(0x03);
    expect(h[off++]).toBe(14);
    expect(new TextDecoder().decode(h.subarray(off, off + 14))).toBe('api.openai.com');
    off += 14;
    expect(h[off++]).toBe(0x01);
    expect(h[off++]).toBe(0xbb);
    expect(h[off++]).toBe(0x00);
    expect(h[off++]).toBe(0x10);
    // 16 padding bytes follow; we don't assert their values (random) but the
    // total length is fixed.
    expect(h.byteLength).toBe(off + 16);
  });
});

describe('dialShadowsocks2022 — SIP022 happy path', () => {
  it('completes when server echoes the salt and responds within the ±30s window', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const TAG = 16;

    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = blake3(concat(PSK_BYTES, sendSalt), { dkLen: KEY_LEN, context: SUBKEY_CONTEXT });
    const fixedSealed = await srv.read(1 + 8 + 2 + TAG);
    const fixedPlain = gcm(sendKey, nonce(0)).decrypt(fixedSealed);
    expect(fixedPlain[0]).toBe(0x00); // request type
    const variableLen = (fixedPlain[9]! << 8) | fixedPlain[10]!;
    const variableSealed = await srv.read(variableLen + TAG);
    const variablePlain = gcm(sendKey, nonce(1)).decrypt(variableSealed);
    expect(variablePlain[0]).toBe(0x03);
    expect(variablePlain[1]).toBe(14);
    expect(new TextDecoder().decode(variablePlain.subarray(2, 16))).toBe('api.openai.com');
    expect(variablePlain[16]).toBe(0x01);
    expect(variablePlain[17]).toBe(0xbb);

    // Server reply.
    sendServerHandshake(srv, sendSalt, KEY_LEN, /* skewSec */ 0, /* echoCorrect */ true, 'OK');

    const result = await promise;
    const reader = result.readable.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe('OK');
  });
});

describe('dialShadowsocks2022 — SIP022 defenses', () => {
  it('rejects a response whose timestamp is more than 30s in the past', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: 31, echoCorrect: true })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/timestamp skew/),
    });
  });

  it('rejects a response whose timestamp is more than 30s in the future', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: -31, echoCorrect: true })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/timestamp skew/),
    });
  });

  it('rejects a response whose salt-echo does not match our request salt', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: 0, echoCorrect: false })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/salt-echo mismatch/),
    });
  });
});

const runWithServerHandshakeOptions = async (
  serverOpts: { skewSec: number; echoCorrect: boolean },
): Promise<unknown> => {
  const fake = makeFakeSocketDial();
  const dialPromise = dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
  const srv = await fake.awaitConnect();
  const KEY_LEN = 16;
  const TAG = 16;

  // Drain the dial side so the dialer is now waiting on us.
  const sendSalt = await srv.read(KEY_LEN);
  await srv.read(1 + 8 + 2 + TAG);
  // Drain the variable-header AEAD record (we don't decrypt it; the dialer
  // wrote everything in one shot, so just consume what's still buffered).
  const remaining = srv.peekWritten().byteLength;
  if (remaining > 0) await srv.read(remaining);

  const dialerSendSalt = serverOpts.echoCorrect ? sendSalt : new Uint8Array(KEY_LEN);
  sendServerHandshake(srv, dialerSendSalt, KEY_LEN, serverOpts.skewSec, true, 'OK');

  const result = await dialPromise;
  const reader = result.readable.getReader();
  return await reader.read();
};

interface FakeServerLike {
  respond: (b: Uint8Array) => void;
}

const sendServerHandshake = (
  srv: FakeServerLike,
  sendSaltToEcho: Uint8Array,
  keyLen: number,
  skewSec: number,
  echoCorrect: boolean,
  payload: string,
): void => {
  const TAG = 16;
  const recvSalt = new Uint8Array(keyLen);
  crypto.getRandomValues(recvSalt);
  const recvKey = blake3(concat(PSK_BYTES, recvSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT });
  let recvNonce = 0n;

  // Response fixed header: type=0x01 | timestamp(u64be) | salt-echo(keyLen) | first_payload_len(u16be) + tag.
  const respTs = BigInt(Math.floor(Date.now() / 1000)) - BigInt(skewSec);
  const fixedPlain = new Uint8Array(1 + 8 + keyLen + 2);
  fixedPlain[0] = 0x01;
  for (let i = 7; i >= 0; i--) {
    fixedPlain[1 + i] = Number(respTs >> BigInt((7 - i) * 8) & 0xffn);
  }
  // Caller controls whether the echo matches.
  const echoToWrite = echoCorrect ? sendSaltToEcho : new Uint8Array(keyLen);
  fixedPlain.set(echoToWrite, 1 + 8);
  const payloadBytes = new TextEncoder().encode(payload);
  fixedPlain[1 + 8 + keyLen] = (payloadBytes.byteLength >> 8) & 0xff;
  fixedPlain[1 + 8 + keyLen + 1] = payloadBytes.byteLength & 0xff;
  const fixedSealed = gcm(recvKey, nonce(Number(recvNonce++))).encrypt(fixedPlain);
  const payloadSealed = gcm(recvKey, nonce(Number(recvNonce++))).encrypt(payloadBytes);

  const out = new Uint8Array(keyLen + fixedSealed.byteLength + payloadSealed.byteLength);
  out.set(recvSalt, 0);
  out.set(fixedSealed, keyLen);
  out.set(payloadSealed, keyLen + fixedSealed.byteLength);
  srv.respond(out);
};

const nonce = (counter: number): Uint8Array => {
  const out = new Uint8Array(12);
  let c = counter;
  for (let i = 0; i < 12; i++) {
    out[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return out;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};
