// Shadowsocks AEAD-2018 dialer.
//
// Spec: https://shadowsocks.org/doc/aead.html (SIP004 + SIP007).
//
// TCP frame layout:
//   [random salt][len(2B BE) + tag(16B)][payload(<=16K) + tag(16B)]…
//
// Master key:
//   EVP_BytesToKey(password) — MD5-chained: M0 = MD5(password); Mi = MD5(M(i-1) || password); concat to keyLen.
//
// Subkey (per direction):
//   subkey = HKDF-SHA1(masterKey, salt, "ss-subkey", keyLen)
//
// Nonce:
//   12-byte LE counter, starts at 0, +1 per AEAD op.
//
// First plaintext chunk: SOCKS5-style address: [ATYP][addr][port BE]

import { gcm } from '@noble/ciphers/aes.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';

import { ProxyDialError } from '../errors.ts';
import type { ShadowsocksProxyConfig, SsMethod } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';

const METHOD_KEY_LEN: Record<SsMethod, number> = {
  'chacha20-ietf-poly1305': 32,
  'aes-256-gcm': 32,
  'aes-128-gcm': 16,
};

const TAG_LEN = 16;
const NONCE_LEN = 12;
const MAX_PAYLOAD = 0x3fff;

export const dialShadowsocks = async (
  config: ShadowsocksProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  const keyLen = METHOD_KEY_LEN[config.method];
  if (!keyLen) throw new Error(`unsupported method: ${config.method}`);

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
    return await dialShadowsocksInner(socket, config.method, config.password, keyLen, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialShadowsocksInner = async (
  socket: DialedSocket,
  method: SsMethod,
  password: string,
  keyLen: number,
  target: DialTarget,
): Promise<DialResult> => {
  const masterKey = evpBytesToKey(password, keyLen);

  // Per-direction salts and subkeys
  const sendSalt = randomBytes(keyLen);
  const sendSubkey = hkdf(sha1, masterKey, sendSalt, asciiBytes('ss-subkey'), keyLen);
  const sendCipher = makeAead(method, sendSubkey);
  let sendNonce = 0n;

  // Receive subkey is derived after we read the server's salt.
  let recvCipher: Aead | null = null;
  let recvNonce = 0n;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let leftover: Uint8Array | undefined;
  const readExactly = async (n: number): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(n);
    let got = 0;
    if (leftover?.byteLength) {
      const take = Math.min(n, leftover.byteLength);
      out.set(leftover.subarray(0, take), 0);
      got += take;
      leftover = take < leftover.byteLength ? leftover.subarray(take) : undefined;
    }
    while (got < n) {
      const r = await reader.read();
      if (r.done) throw new Error(`SS: EOF, want ${n} got ${got}`);
      const need = n - got;
      if (r.value.byteLength <= need) {
        out.set(r.value, got);
        got += r.value.byteLength;
      } else {
        out.set(r.value.subarray(0, need), got);
        leftover = r.value.subarray(need);
        got += need;
      }
    }
    return out;
  };

  // Build the SS address header for the first payload chunk.
  const addrBytes = buildSocksAddress(target.host, target.port);

  // Encrypt and send: [salt] + frame(addr+initialPayload). For an AEAD frame,
  // we encrypt up to MAX_PAYLOAD plaintext bytes per record. The first record
  // contains the address. Subsequent records carry the inner-TLS bytes.
  const initialFrame = encryptFrame(sendCipher, addrBytes, sendNonce);
  sendNonce += 2n;
  const initialOut = concat(sendSalt, initialFrame);
  await writer.write(initialOut);
  // We're about to hand the writer off via the SS-encrypting WritableStream
  // wrapper. Construct a wrapping WritableStream that frames each chunk as
  // an SS AEAD record before forwarding to the underlying socket.
  writer.releaseLock();

  // Track whether the SS receive side has produced any successful payload
  // yet — before the first plaintext is enqueued, an AEAD auth failure is
  // overwhelmingly likely to mean wrong password / wrong cipher (i.e. a
  // misconfigured proxy), and tagging it as `proxy-handshake` lets the dial
  // layer fall through to the next entry instead of masquerading the cause
  // as an opaque inner-TLS failure.
  let recvBootstrapped = false;
  // Build the SS-decrypted readable
  const ssReadable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!recvCipher) {
          // Read the server's salt
          const saltBuf = await readExactly(keyLen);
          const recvSubkey = hkdf(sha1, masterKey, saltBuf, asciiBytes('ss-subkey'), keyLen);
          recvCipher = makeAead(method, recvSubkey);
        }
        // Read length record (2-byte len + 16-byte tag)
        const lenSealed = await readExactly(2 + TAG_LEN);
        const lenPlain = recvCipher.decrypt(nonceBytes(recvNonce), lenSealed);
        recvNonce++;
        const payloadLen = (lenPlain[0]! << 8) | lenPlain[1]!;
        if (payloadLen === 0 || payloadLen > MAX_PAYLOAD) {
          controller.error(new ProxyDialError(`SS: bad payload length ${payloadLen}`, 'proxy-handshake'));
          return;
        }
        const payloadSealed = await readExactly(payloadLen + TAG_LEN);
        const payloadPlain = recvCipher.decrypt(nonceBytes(recvNonce), payloadSealed);
        recvNonce++;
        recvBootstrapped = true;
        controller.enqueue(payloadPlain as Uint8Array<ArrayBuffer>);
      } catch (e) {
        if (!recvBootstrapped && !(e instanceof ProxyDialError)) {
          controller.error(new ProxyDialError(`SS handshake decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'proxy-handshake', { cause: e }));
          return;
        }
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  // SS-encrypting writable
  const ssWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      // Re-acquire the writer per frame so the SS-encrypting writable owns the underlying lock only while it actively writes a record.
      const w = socket.writable.getWriter();
      try {
        // Split into MAX_PAYLOAD-sized records.
        let off = 0;
        while (off < chunk.byteLength) {
          const piece = chunk.subarray(off, Math.min(off + MAX_PAYLOAD, chunk.byteLength));
          const frame = encryptFrame(sendCipher, piece, sendNonce);
          sendNonce += 2n;
          await w.write(frame);
          off += piece.byteLength;
        }
      } finally {
        w.releaseLock();
      }
    },
    async close() {
      try { await socket.close(); } catch {}
    },
    abort() {
      try { void socket.close(); } catch {}
    },
  });

  return { readable: ssReadable, writable: ssWritable };
};

interface Aead {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

const makeAead = (method: SsMethod, key: Uint8Array): Aead => {
  if (method === 'chacha20-ietf-poly1305') {
    return {
      encrypt: (nonce, pt) => chacha20poly1305(key, nonce).encrypt(pt),
      decrypt: (nonce, ct) => chacha20poly1305(key, nonce).decrypt(ct),
    };
  } else if (method === 'aes-256-gcm' || method === 'aes-128-gcm') {
    return {
      encrypt: (nonce, pt) => gcm(key, nonce).encrypt(pt),
      decrypt: (nonce, ct) => gcm(key, nonce).decrypt(ct),
    };
  }
  throw new Error(`unsupported method ${method}`);
};

const encryptFrame = (cipher: Aead, payload: Uint8Array, baseNonce: bigint): Uint8Array<ArrayBuffer> => {
  if (payload.byteLength > MAX_PAYLOAD) throw new Error('payload exceeds MAX_PAYLOAD');
  const lenBytes = new Uint8Array(2);
  lenBytes[0] = (payload.byteLength >> 8) & 0xff;
  lenBytes[1] = payload.byteLength & 0xff;
  const lenSealed = cipher.encrypt(nonceBytes(baseNonce), lenBytes);
  const payloadSealed = cipher.encrypt(nonceBytes(baseNonce + 1n), payload);
  const out = new Uint8Array(lenSealed.byteLength + payloadSealed.byteLength);
  out.set(lenSealed, 0);
  out.set(payloadSealed, lenSealed.byteLength);
  return out;
};

const nonceBytes = (counter: bigint): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(NONCE_LEN);
  let c = counter;
  for (let i = 0; i < NONCE_LEN; i++) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
};

const evpBytesToKey = (password: string, keyLen: number): Uint8Array<ArrayBuffer> => {
  const pw = asciiBytes(password);
  const out = new Uint8Array(keyLen);
  let prev = new Uint8Array(0);
  let off = 0;
  while (off < keyLen) {
    const buf = concat(prev, pw);
    const m = md5(buf);
    const take = Math.min(m.byteLength, keyLen - off);
    out.set(m.subarray(0, take), off);
    off += take;
    prev = m;
  }
  return out;
};

const asciiBytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

const buildSocksAddress = (host: string, port: number): Uint8Array<ArrayBuffer> => {
  const enc = new TextEncoder();
  const dom = enc.encode(host);
  if (dom.byteLength > 255) throw new Error('SS: address too long');
  const out = new Uint8Array(1 + 1 + dom.byteLength + 2);
  out[0] = 0x03;
  out[1] = dom.byteLength;
  out.set(dom, 2);
  out[2 + dom.byteLength] = (port >> 8) & 0xff;
  out[2 + dom.byteLength + 1] = port & 0xff;
  return out;
};

const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};
