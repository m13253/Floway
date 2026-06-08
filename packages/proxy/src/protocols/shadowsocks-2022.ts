// Shadowsocks 2022 dialer (SIP022).
//
// Spec: https://github.com/shadowsocks/shadowsocks-org/blob/main/docs/doc/sip022.md
//
// Differences from AEAD-2018:
//   - PSK is the raw decoded key bytes (no EVP_BytesToKey).
//   - Subkey: BLAKE3.derive_key("shadowsocks 2022 session subkey", PSK||salt)
//   - TCP request format prepended with a fixed 11-byte fixed header
//     (type|timestamp(u64be)|len(u16be)) and a variable header
//     (ATYP|addr|port|padlen(u16be)|pad|initial_payload).
//   - TCP response: server echoes the request salt and includes a fresh
//     timestamp (must be within 30s of now).

import { gcm } from '@noble/ciphers/aes.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { blake3 } from '@noble/hashes/blake3.js';

import { ProxyDialError } from '../errors.ts';
import type { Shadowsocks2022ProxyConfig, Ss2022Method } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { makeExactReader } from './exact-reader.ts';
import { concat, randomBytes } from '@floway-dev/http';

const KEY_LEN_2022: Record<Ss2022Method, number> = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
};

const TAG = 16;
const NONCE = 12;
// SIP022 uses a u16 length field. Servers can send up to 0xffff per record;
// AEAD-2018's 0x3fff limit does not apply.
const MAX = 0xffff;
const SUBKEY_CONTEXT_BYTES = new TextEncoder().encode('shadowsocks 2022 session subkey');

const REQ_HEADER_TYPE = 0x00;
const RESP_HEADER_TYPE = 0x01;

export const dialShadowsocks2022 = async (
  config: Shadowsocks2022ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  const keyLen = KEY_LEN_2022[config.method];
  // Wire-shape config checks raise typed dial errors so a single misconfigured
  // proxy entry doesn't escape ProxyDialError handling and kill the whole
  // fallback chain — the next entry is allowed to try. The decoder also
  // throws on unparseable input (atob on bad base64); wrap that at the same
  // layer so a parse blow-up reaches the fallback chain as a dial error
  // rather than a generic Error.
  let psk: Uint8Array<ArrayBuffer>;
  try {
    psk = base64Decode(config.passwordBase64);
  } catch (cause) {
    throw new ProxyDialError('SS2022: invalid base64 in PSK', 'tcp-connect', { cause });
  }
  // PSK byte-length is part of the SIP022 wire contract: a key shorter or
  // longer than the cipher demands derives a wrong subkey and the very first
  // record fails AEAD auth. Tag as a typed dial error so a single misconfigured
  // proxy entry doesn't escape ProxyDialError handling and kill the whole
  // fallback chain — the next entry is allowed to try.
  if (psk.byteLength !== keyLen) {
    throw new ProxyDialError(
      `SS2022: PSK is ${psk.byteLength} bytes, expected ${keyLen}`,
      'tcp-connect',
    );
  }

  let socket: DialedSocket;
  try {
    socket = await options.socketDial.connect(config.host, config.port, { signal: options.signal });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${config.host}:${config.port} failed`,
      'tcp-connect',
      { cause },
    );
  }

  try {
    return await dialShadowsocks2022Inner(socket, config.method, psk, keyLen, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialShadowsocks2022Inner = async (
  socket: DialedSocket,
  method: Ss2022Method,
  psk: Uint8Array,
  keyLen: number,
  target: DialTarget,
): Promise<DialResult> => {
  const sendSalt = randomBytes(keyLen);
  const sendKey = blake3(concat(psk, sendSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT_BYTES });
  const sendCipher = makeAead(method, sendKey);
  let sendNonce = 0n;
  let recvCipher: Aead | null = null;
  let recvNonce = 0n;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const readN = makeExactReader(reader, 'SS2022');

  // Build the request:
  //   - sendSalt
  //   - fixed header AEAD: [type=0x00 | timestamp(u64be) | len(u16be)] + tag
  //     where len = byte length of the variable header (excluding tag).
  //   - variable header AEAD: [ATYP|addr|port|padlen(u16be)|pad|initial_payload] + tag
  const variableHeader = buildSs2022RequestHeader(target.host, target.port);
  const fixedPlain = new Uint8Array(1 + 8 + 2);
  fixedPlain[0] = REQ_HEADER_TYPE;
  writeU64BE(fixedPlain, 1, BigInt(Math.floor(Date.now() / 1000)));
  fixedPlain[9] = (variableHeader.byteLength >> 8) & 0xff;
  fixedPlain[10] = variableHeader.byteLength & 0xff;

  const fixedSealed = sendCipher.encrypt(nonce(sendNonce++), fixedPlain);
  const variableSealed = sendCipher.encrypt(nonce(sendNonce++), variableHeader);
  const initialOut = new Uint8Array(sendSalt.byteLength + fixedSealed.byteLength + variableSealed.byteLength);
  initialOut.set(sendSalt, 0);
  initialOut.set(fixedSealed, sendSalt.byteLength);
  initialOut.set(variableSealed, sendSalt.byteLength + fixedSealed.byteLength);
  await writer.write(initialOut);
  writer.releaseLock();

  // See shadowsocks.ts for the same fail-classification rationale: an AEAD
  // auth failure before the receive side has produced any plaintext is
  // overwhelmingly a misconfigured key, so flag the dial as
  // proxy-handshake to let the dial layer fall through cleanly.
  let recvBootstrapped = false;
  const ssReadable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!recvCipher) {
          // Read server salt
          const recvSalt = await readN(keyLen);
          const recvKey = blake3(concat(psk, recvSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT_BYTES });
          recvCipher = makeAead(method, recvKey);
          // Read response fixed header AEAD: [type=0x01 | timestamp(u64be) | salt-echo(keyLen) | len(u16be)] + tag
          const respFixedSealed = await readN(1 + 8 + keyLen + 2 + TAG);
          const respFixedPlain = recvCipher.decrypt(nonce(recvNonce++), respFixedSealed);
          if (respFixedPlain[0] !== RESP_HEADER_TYPE) {
            throw new ProxyDialError(`SS2022: bad response type ${respFixedPlain[0]}`, 'proxy-handshake');
          }
          // SIP022's replay defense rests on TWO checks: the salt-echo
          // (binds the response to our specific request) AND the
          // timestamp window (rejects a recorded-and-replayed response
          // older than the spec's 30-second window). Skipping the
          // window would weaken our SIP022 connection to AEAD-2018-like
          // strength.
          let respTs = 0n;
          for (let i = 0; i < 8; i++) respTs = (respTs << 8n) | BigInt(respFixedPlain[1 + i]!);
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          const skew = nowSec - respTs;
          if (skew > 30n || skew < -30n) {
            throw new ProxyDialError(`SS2022: response timestamp skew ${skew}s outside ±30s window`, 'proxy-handshake');
          }
          const echoStart = 1 + 8;
          for (let i = 0; i < keyLen; i++) {
            if (respFixedPlain[echoStart + i] !== sendSalt[i]) {
              throw new ProxyDialError('SS2022: salt-echo mismatch', 'proxy-handshake');
            }
          }
          // First-payload length
          const firstLen = (respFixedPlain[1 + 8 + keyLen]! << 8) | respFixedPlain[1 + 8 + keyLen + 1]!;
          if (firstLen > MAX) throw new ProxyDialError(`SS2022: bad first payload length ${firstLen}`, 'proxy-handshake');
          const firstSealed = await readN(firstLen + TAG);
          const firstPlain = recvCipher.decrypt(nonce(recvNonce++), firstSealed);
          recvBootstrapped = true;
          if (firstPlain.byteLength) controller.enqueue(firstPlain as Uint8Array<ArrayBuffer>);
          return;
        }
        // Read length record
        const lenSealed = await readN(2 + TAG);
        const lenPlain = recvCipher.decrypt(nonce(recvNonce++), lenSealed);
        const len = (lenPlain[0]! << 8) | lenPlain[1]!;
        if (len === 0 || len > MAX) {
          controller.error(new ProxyDialError(`SS2022: bad payload length ${len}`, 'proxy-handshake'));
          return;
        }
        const ptSealed = await readN(len + TAG);
        const pt = recvCipher.decrypt(nonce(recvNonce++), ptSealed);
        controller.enqueue(pt as Uint8Array<ArrayBuffer>);
      } catch (e) {
        if (!recvBootstrapped && !(e instanceof ProxyDialError)) {
          controller.error(new ProxyDialError(`SS2022 handshake decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'proxy-handshake', { cause: e }));
          return;
        }
        controller.error(e);
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  const ssWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const w = socket.writable.getWriter();
      try {
        let off = 0;
        while (off < chunk.byteLength) {
          const piece = chunk.subarray(off, Math.min(off + MAX, chunk.byteLength));
          const lenBytes = new Uint8Array([(piece.byteLength >> 8) & 0xff, piece.byteLength & 0xff]);
          const lenSealed = sendCipher.encrypt(nonce(sendNonce++), lenBytes);
          const ptSealed = sendCipher.encrypt(nonce(sendNonce++), piece);
          await w.write(concat(lenSealed, ptSealed));
          off += piece.byteLength;
        }
      } finally {
        w.releaseLock();
      }
    },
    async close() { try { await socket.close(); } catch { /* socket already closed */ } },
    async abort() { try { await socket.close(); } catch { /* socket already closed */ } },
  });

  return { readable: ssReadable, writable: ssWritable };
};

interface Aead {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

const makeAead = (method: Ss2022Method, key: Uint8Array): Aead => {
  if (method === '2022-blake3-chacha20-poly1305') {
    return {
      encrypt: (n, pt) => chacha20poly1305(key, n).encrypt(pt),
      decrypt: (n, ct) => chacha20poly1305(key, n).decrypt(ct),
    };
  }
  return {
    encrypt: (n, pt) => gcm(key, n).encrypt(pt),
    decrypt: (n, ct) => gcm(key, n).decrypt(ct),
  };
};

/**
 * Build the SS2022 variable header for a domain target. Exported for tests.
 *
 *   ATYP=0x03 | dom_len | dom | port[BE] | padlen[BE u16] | pad | initial_payload
 *
 * SIP022 requires either non-zero padding OR a non-empty initial_payload in
 * the very first request frame. The dialer has no application data to send
 * yet (the inner TLS handshake hasn't started), so we always emit 16 random
 * padding bytes and an empty initial_payload.
 */
export const buildSs2022RequestHeader = (host: string, port: number): Uint8Array<ArrayBuffer> => {
  const enc = new TextEncoder();
  const dom = enc.encode(host);
  // ATYP=0x03 encodes the domain length in a single byte; a hostname over
  // 255 bytes can't be addressed in this header. Throw a typed dial error
  // so the fallback chain advances rather than silently truncating the
  // length byte and corrupting the wire format.
  if (dom.byteLength > 255) throw new ProxyDialError('SS2022: hostname too long', 'proxy-handshake');
  const padLen = 16;
  const pad = randomBytes(padLen);
  const out = new Uint8Array(1 + 1 + dom.byteLength + 2 + 2 + padLen);
  let off = 0;
  out[off++] = 0x03;
  out[off++] = dom.byteLength;
  out.set(dom, off); off += dom.byteLength;
  out[off++] = (port >> 8) & 0xff;
  out[off++] = port & 0xff;
  out[off++] = (padLen >> 8) & 0xff;
  out[off++] = padLen & 0xff;
  out.set(pad, off);
  return out;
};

const nonce = (counter: bigint): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(NONCE);
  let c = counter;
  for (let i = 0; i < NONCE; i++) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
};

const writeU64BE = (buf: Uint8Array, off: number, value: bigint): void => {
  for (let i = 7; i >= 0; i--) {
    buf[off + i] = Number(value & 0xffn);
    value >>= 8n;
  }
};

const base64Decode = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
