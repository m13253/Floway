// Shadowsocks AEAD-2018 client.
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

import { connect } from 'cloudflare:sockets'
import { md5 } from '@noble/hashes/legacy.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { gcm } from '@noble/ciphers/aes.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { runHttp1Stream } from '../http1-stream.js'
import { userspaceTls } from '../tls.js'
import { type TargetSpec } from '../types.js'

export type SsMethod = 'chacha20-ietf-poly1305' | 'aes-256-gcm' | 'aes-128-gcm'

export interface ShadowsocksOptions {
  serverHost: string
  serverPort: number
  method: SsMethod
  password: string
  target: TargetSpec
}

const METHOD_KEY_LEN: Record<SsMethod, number> = {
  'chacha20-ietf-poly1305': 32,
  'aes-256-gcm': 32,
  'aes-128-gcm': 16,
}

const TAG_LEN = 16
const NONCE_LEN = 12
const MAX_PAYLOAD = 0x3fff

export async function runShadowsocks(opts: ShadowsocksOptions): Promise<Response> {
  const { serverHost, serverPort, method, password, target } = opts
  const keyLen = METHOD_KEY_LEN[method]
  if (!keyLen) throw new Error(`unsupported method: ${method}`)

  const socket = connect(
    { hostname: serverHost, port: serverPort },
    { secureTransport: 'off', allowHalfOpen: true },
  )

  const masterKey = evpBytesToKey(password, keyLen)

  // Per-direction salts and subkeys
  const sendSalt = randomBytes(keyLen)
  const sendSubkey = hkdf(sha1, masterKey, sendSalt, asciiBytes('ss-subkey'), keyLen)
  const sendCipher = makeAead(method, sendSubkey)
  let sendNonce = 0n

  // Receive subkey is derived after we read the server's salt.
  let recvCipher: Aead | null = null
  let recvNonce = 0n

  const writer = socket.writable.getWriter()
  const reader = socket.readable.getReader()

  // Build the SS address header for the first payload chunk.
  const addrBytes = buildSocksAddress(target.host, target.port)

  // Encrypt and send: [salt] + frame(addr+initialPayload). For an AEAD frame,
  // we encrypt up to MAX_PAYLOAD plaintext bytes per record. The first record
  // contains the address. Subsequent records carry the inner-TLS bytes.
  const initialFrame = encryptFrame(sendCipher, addrBytes, sendNonce)
  sendNonce += 2n
  const initialOut = concat(sendSalt, initialFrame)
  await writer.write(initialOut)
  // We're about to hand the writer off via the userspace-TLS wrapper.
  // Construct a wrapping WritableStream that frames each chunk as an SS AEAD
  // record before forwarding to the underlying socket.
  writer.releaseLock()

  // Build the SS-decrypted readable
  const ssReadable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!recvCipher) {
          // Read the server's salt
          const saltBuf = await readExactly(reader, keyLen)
          const recvSubkey = hkdf(sha1, masterKey, saltBuf, asciiBytes('ss-subkey'), keyLen)
          recvCipher = makeAead(method, recvSubkey)
        }
        // Read length record (2-byte len + 16-byte tag)
        const lenSealed = await readExactly(reader, 2 + TAG_LEN)
        if (!lenSealed) {
          controller.close()
          return
        }
        const lenPlain = recvCipher.decrypt(nonceBytes(recvNonce), lenSealed)
        recvNonce++
        const payloadLen = (lenPlain[0]! << 8) | lenPlain[1]!
        if (payloadLen === 0 || payloadLen > MAX_PAYLOAD) {
          controller.error(new Error(`SS: bad payload length ${payloadLen}`))
          return
        }
        const payloadSealed = await readExactly(reader, payloadLen + TAG_LEN)
        if (!payloadSealed) {
          controller.error(new Error('SS: EOF mid-record'))
          return
        }
        const payloadPlain = recvCipher.decrypt(nonceBytes(recvNonce), payloadSealed)
        recvNonce++
        controller.enqueue(payloadPlain as Uint8Array<ArrayBuffer>)
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  // SS-encrypting writable
  const ssWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      // Re-acquire writer briefly per frame; this simplifies lifetime since we
      // already released the lock above. (workerd's WritableStream allows
      // re-acquire.)
      const w = socket.writable.getWriter()
      try {
        // Split into MAX_PAYLOAD-sized records.
        let off = 0
        while (off < chunk.byteLength) {
          const piece = chunk.subarray(off, Math.min(off + MAX_PAYLOAD, chunk.byteLength))
          const frame = encryptFrame(sendCipher, piece, sendNonce)
          sendNonce += 2n
          await w.write(frame)
          off += piece.byteLength
        }
      } finally {
        w.releaseLock()
      }
    },
    async close() {
      try { await socket.close() } catch {}
    },
    abort() {
      try { socket.close() } catch {}
    },
  })

  if (target.tls) {
    const tls = await userspaceTls({ readable: ssReadable, writable: ssWritable }, { host: target.host })
    return await runHttp1Stream(tls, target)
  } else {
    return await runHttp1Stream({ readable: ssReadable, writable: ssWritable }, target)
  }
}

interface Aead {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array
}

function makeAead(method: SsMethod, key: Uint8Array): Aead {
  if (method === 'chacha20-ietf-poly1305') {
    return {
      encrypt: (nonce, pt) => chacha20poly1305(key, nonce).encrypt(pt),
      decrypt: (nonce, ct) => chacha20poly1305(key, nonce).decrypt(ct),
    }
  } else if (method === 'aes-256-gcm' || method === 'aes-128-gcm') {
    return {
      encrypt: (nonce, pt) => gcm(key, nonce).encrypt(pt),
      decrypt: (nonce, ct) => gcm(key, nonce).decrypt(ct),
    }
  }
  throw new Error(`unsupported method ${method}`)
}

function encryptFrame(cipher: Aead, payload: Uint8Array, baseNonce: bigint): Uint8Array<ArrayBuffer> {
  if (payload.byteLength > MAX_PAYLOAD) throw new Error('payload exceeds MAX_PAYLOAD')
  const lenBytes = new Uint8Array(2)
  lenBytes[0] = (payload.byteLength >> 8) & 0xff
  lenBytes[1] = payload.byteLength & 0xff
  const lenSealed = cipher.encrypt(nonceBytes(baseNonce), lenBytes)
  const payloadSealed = cipher.encrypt(nonceBytes(baseNonce + 1n), payload)
  const out = new Uint8Array(lenSealed.byteLength + payloadSealed.byteLength)
  out.set(lenSealed, 0)
  out.set(payloadSealed, lenSealed.byteLength)
  return out
}

function nonceBytes(counter: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(NONCE_LEN)
  let c = counter
  for (let i = 0; i < NONCE_LEN; i++) {
    out[i] = Number(c & 0xffn)
    c >>= 8n
  }
  return out
}

function evpBytesToKey(password: string, keyLen: number): Uint8Array<ArrayBuffer> {
  const pw = asciiBytes(password)
  const out = new Uint8Array(keyLen)
  let prev = new Uint8Array(0)
  let off = 0
  while (off < keyLen) {
    const buf = concat(prev, pw)
    const m = md5(buf)
    const take = Math.min(m.byteLength, keyLen - off)
    out.set(m.subarray(0, take), off)
    off += take
    prev = m
  }
  return out
}

function asciiBytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>
}

function buildSocksAddress(host: string, port: number): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const dom = enc.encode(host)
  if (dom.byteLength > 255) throw new Error('SS: address too long')
  const out = new Uint8Array(1 + 1 + dom.byteLength + 2)
  out[0] = 0x03
  out[1] = dom.byteLength
  out.set(dom, 2)
  out[2 + dom.byteLength] = (port >> 8) & 0xff
  out[2 + dom.byteLength + 1] = port & 0xff
  return out
}

async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(n)
  let got = 0
  let leftover = (reader as unknown as { __leftover?: Uint8Array }).__leftover
  if (leftover && leftover.byteLength) {
    const take = Math.min(n, leftover.byteLength)
    out.set(leftover.subarray(0, take), 0)
    got += take
    if (take < leftover.byteLength) {
      ;(reader as unknown as { __leftover?: Uint8Array }).__leftover = leftover.subarray(take)
    } else {
      ;(reader as unknown as { __leftover?: Uint8Array }).__leftover = undefined
    }
  }
  while (got < n) {
    const r = await reader.read()
    if (r.done) throw new Error(`SS: EOF, want ${n} got ${got}`)
    const need = n - got
    if (r.value.byteLength <= need) {
      out.set(r.value, got)
      got += r.value.byteLength
    } else {
      out.set(r.value.subarray(0, need), got)
      ;(reader as unknown as { __leftover?: Uint8Array }).__leftover = r.value.subarray(need)
      got += need
    }
  }
  return out
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(a.byteLength + b.byteLength)
  r.set(a, 0)
  r.set(b, a.byteLength)
  return r
}
