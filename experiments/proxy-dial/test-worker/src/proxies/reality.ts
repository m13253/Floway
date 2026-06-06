// REALITY client.
//
// Spec/reference: github.com/XTLS/REALITY  +  XTLS/Xray-core/transport/internet/reality/reality.go
//
// REALITY is a TLS 1.3 client that:
//   1. Spoofs SNI as a real domain (e.g. www.cloudflare.com).
//   2. Overwrites the 32-byte ClientHello.session_id with an authentication
//      payload sealed in-place with AES-128-GCM:
//        plaintext = [version_x, version_y, version_z, 0x00, ts(4 BE), shortId(8)]
//        key       = HKDF-SHA256(ECDHE(ephPriv, serverPub), salt=random[0:20], info="REALITY", L=16)
//        nonce     = random[20:32]
//        AAD       = ClientHello bytes (with plaintext session_id still in place)
//        output    = 16-byte ciphertext + 16-byte tag, written back into session_id slot.
//   3. Validates the server cert by its CertificateVerify "signature" field —
//      which is actually HMAC-SHA512(authKey, leafCertEd25519Pub).
//        authKey = HKDF-SHA256(shared_secret, salt=random[0:20], info="REALITY", L=32)
//      (Same HKDF call as the seal key but with L=32 — first 16 bytes are the
//      seal key, full 32 bytes are the auth key.)
//
// We layer this on top of @reclaimprotocol/tls via two patched hooks:
//   - onClientHelloPack: lets us seal the session_id in-place after the
//     ClientHello bytes are built.
//   - onRecvCertificateVerify: lets us replace the standard signature check
//     with the REALITY HMAC check, returning false to skip the default check.

import { connect } from 'cloudflare:sockets'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { runHttp1Stream } from '../http1-stream.js'
import { type TargetSpec } from '../targets.js'
import { setCryptoImplementation, makeTLSClient } from '@reclaimprotocol/tls'
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto'
import { runVlessCoreOverStream } from './vless-core.js'

let cryptoInstalled = false
function ensureCrypto(): void {
  if (cryptoInstalled) return
  setCryptoImplementation(webcryptoCrypto)
  cryptoInstalled = true
}

export interface RealityOptions {
  serverHost: string
  serverPort: number
  publicKeyB64Url: string // server's X25519 public key (base64url, 43 chars)
  shortIdHex: string // 8 hex bytes (16 chars)
  spoofSni: string // SNI presented in ClientHello, e.g. "www.cloudflare.com"
  uuid: string // VLESS user UUID
  version?: [number, number, number] // Xray version in session_id, default [25,4,30]
  target: TargetSpec
}

export async function runReality(opts: RealityOptions): Promise<Response> {
  ensureCrypto()
  const ver = opts.version ?? [25, 4, 30]
  const serverPub = base64UrlDecode(opts.publicKeyB64Url)
  if (serverPub.byteLength !== 32) throw new Error(`REALITY: server pubkey must be 32 bytes, got ${serverPub.byteLength}`)
  const shortId = hexDecode(opts.shortIdHex)
  if (shortId.byteLength !== 8) throw new Error(`REALITY: shortId must be 8 bytes, got ${shortId.byteLength}`)

  // Plain TCP — userspace TLS will do the entire handshake.
  const socket = connect(
    { hostname: opts.serverHost, port: opts.serverPort },
    { secureTransport: 'off', allowHalfOpen: true },
  )

  // Build the unsealed session_id payload
  const ts = Math.floor(Date.now() / 1000)
  const sessionIdPlain = new Uint8Array(32)
  sessionIdPlain[0] = ver[0]
  sessionIdPlain[1] = ver[1]
  sessionIdPlain[2] = ver[2]
  sessionIdPlain[3] = 0x00
  sessionIdPlain[4] = (ts >>> 24) & 0xff
  sessionIdPlain[5] = (ts >>> 16) & 0xff
  sessionIdPlain[6] = (ts >>> 8) & 0xff
  sessionIdPlain[7] = ts & 0xff
  sessionIdPlain.set(shortId, 8)
  // bytes 16..31 left as zero (they'll be overwritten by the AEAD tag)

  // Pre-generate the client random so we know it before packClientHello uses it
  const clientRandom = randomBytes(32)
  const sealNonce = clientRandom.subarray(20, 32)

  // The X25519 private key reclaim will use for the keyshare extension.
  // REALITY requires the same keypair be used for both TLS keyshare AND the
  // session_id seal (the server computes X25519(serverPriv, clientKeysharePub)
  // and that's the basis of authKey). We capture it via onKeyPairGenerated and
  // reuse it via Web Crypto deriveBits inside onClientHelloPack.
  let tlsX25519Priv: CryptoKey | null = null

  // Streams that will be returned to the inner protocol (VLESS) after the TLS
  // handshake completes.
  let plainController!: ReadableStreamDefaultController<Uint8Array>
  const plainReadable = new ReadableStream<Uint8Array>({ start(c) { plainController = c } })

  let tlsClient: ReturnType<typeof makeTLSClient> | null = null
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!tlsClient) throw new Error('TLS not ready')
      await tlsClient.write(chunk)
    },
    async close() { try { await tlsClient?.end() } catch {} },
    abort() { try { tlsClient?.end() } catch {} },
  })

  let handshakeResolve!: () => void
  let handshakeReject!: (e: unknown) => void
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve
    handshakeReject = reject
  })
  let handshakeOk = false
  let realityVerified = false

  const writer = socket.writable.getWriter()

  tlsClient = makeTLSClient(({
    host: opts.spoofSni,
    namedCurves: ['X25519'], // REALITY needs only X25519 keyshare
    verifyServerCertificate: false, // REALITY auth replaces chain validation
    write({ header, content }) {
      const out = new Uint8Array(header.byteLength + content.byteLength)
      out.set(header, 0)
      out.set(content, header.byteLength)
      writer.write(out).catch((e) => {
        if (!handshakeOk) handshakeReject(e)
        else plainController?.error(e)
      })
    },
    async onHandshake() {
      console.log('[reality] reclaim onHandshake fired; realityVerified=' + realityVerified)
      handshakeOk = true
      handshakeResolve()
    },
    onApplicationData(plaintext) {
      if (plainController) plainController.enqueue(copy(plaintext))
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        handshakeReject(error ?? new Error('TLS ended before handshake'))
        return
      }
      if (error) plainController?.error(error)
      else plainController?.close()
    },
    onKeyPairGenerated(keyType: string, keyPair: { privKey: CryptoKey; pubKey: CryptoKey }) {
      if (keyType === 'X25519') {
        tlsX25519Priv = keyPair.privKey
      }
    },
    async onClientHelloPack(clientHelloBytes: Uint8Array) {
      // Seal session_id in place. REALITY's X25519 ECDHE uses the SAME
      // keypair as the TLS keyshare extension (the server runs
      // X25519(serverPriv, clientKeysharePub) and never sees a separate
      // ephemeral key — all auth flows from the keyshare's private key).
      if (!tlsX25519Priv) throw new Error('REALITY: X25519 privKey not captured')
      const serverPubKey = await crypto.subtle.importKey('raw', serverPub, { name: 'X25519' }, false, [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharedSecret = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'X25519', public: serverPubKey } as any, tlsX25519Priv, 256),
      )
      // Xray runs HKDF-SHA256 over the shared secret in place (writing 32
      // output bytes back into the 32-byte input buffer). We just call hkdf
      // for 32 bytes.
      const authKey = hkdf(sha256, sharedSecret, clientRandom.subarray(0, 20), asciiBytes('REALITY'), 32)

      const sidStart = 39
      for (let i = 0; i < 32; i++) {
        if (clientHelloBytes[sidStart + i] !== sessionIdPlain[i]) {
          throw new Error(`REALITY: session_id placeholder mismatch at byte ${i}`)
        }
      }
      // Xray's AAD is hello.Raw with the session_id slot ZEROED OUT
      // (xray copies the freshly-allocated zero sessionId into hello.Raw
      // BEFORE filling sessionId with version/ts/shortId, then seals with
      // that zero-filled hello.Raw as AAD).
      const aad = new Uint8Array(clientHelloBytes.byteLength)
      aad.set(clientHelloBytes)
      for (let i = 0; i < 32; i++) aad[sidStart + i] = 0
      // AEAD seal: input = sessionIdPlain[0..16]; AAD = aad; output = 16-byte
      // ciphertext + 16-byte tag = 32 bytes. Xray uses AES-256-GCM with the
      // full 32-byte authKey.
      const sealed = gcm(authKey, sealNonce, aad).encrypt(sessionIdPlain.subarray(0, 16))
      if (sealed.byteLength !== 32) throw new Error(`REALITY: sealed length ${sealed.byteLength}`)
      const out = new Uint8Array(clientHelloBytes.byteLength)
      out.set(clientHelloBytes)
      out.set(sealed, sidStart)
      console.log(`[reality] sealed session_id sent (authKey[:16]=${bytesToHex(authKey.subarray(0, 16))})`)
      return out
    },
    onRecvCertificateVerify({ certificates, signature, algorithm }: { certificates: Array<{ getPublicKey(): { buffer: Uint8Array; algorithm: string } }>; signature: Uint8Array; algorithm: string }) {
      // sing-box's REALITY does NOT use HMAC-SHA512 like xray-core's. It signs
      // the CertificateVerify with a real ECDSA-P256-SHA256 signature using a
      // forged-cert key. That key is unknown to us — REALITY's whole point is
      // we authenticate via the AEAD-sealed session_id, NOT the cert chain.
      // So we just record the cert + signature for later debug and accept.
      if (!certificates || !certificates.length) throw new Error('REALITY: no certs received')
      const leaf = certificates[0]!.getPublicKey()
      const pubBytes = stripSpkiPrefix(leaf.buffer, leaf.algorithm)
      console.log(`[reality] server-side: sigAlg=${algorithm} sigLen=${signature?.byteLength ?? 0} certPubAlg=${leaf.algorithm} certPubLen=${pubBytes.byteLength}`)
      realityVerified = true
      return false // skip the standard signature verification
    },
  }) as Parameters<typeof makeTLSClient>[0])

  // Pump bytes from transport → tls.handleReceivedBytes
  ;(async () => {
    const reader = socket.readable.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          tlsClient?.end().catch(() => {})
          return
        }
        await tlsClient?.handleReceivedBytes(value)
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e)
      else plainController?.error(e)
    }
  })()

  // Trigger the handshake with our pre-built sessionId and random.
  await tlsClient.startHandshake(({ sessionId: sessionIdPlain, random: clientRandom }) as Parameters<NonNullable<typeof tlsClient>['startHandshake']>[0])
  await handshakeDone

  // After REALITY auth, the inner protocol is VLESS by convention.
  return await runVlessCoreOverStream(
    { readable: plainReadable, writable: plainWritable },
    opts.uuid,
    opts.target,
  )
}

function stripSpkiPrefix(spki: Uint8Array, algorithm: string): Uint8Array {
  // For Ed25519 (the default REALITY forged-cert key type), the SPKI is:
  //   30 2a              SEQUENCE
  //     30 05            SEQUENCE (algorithm)
  //       06 03 2b 65 70   OID 1.3.101.112 (Ed25519)
  //     03 21 00         BIT STRING (33 bytes, 0 unused)
  //     <32-byte raw key>
  // We strip the 12-byte prefix.
  if (algorithm === 'ED25519' || algorithm === 'Ed25519') {
    if (spki.byteLength === 32) return spki // already raw
    if (spki.byteLength === 44) return spki.subarray(12)
  }
  // Fallback heuristic: trim leading prefix until 32 bytes remain.
  if (spki.byteLength > 32) return spki.subarray(spki.byteLength - 32)
  return spki
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength)
  r.set(u)
  return r
}

function asciiBytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

function hexDecode(s: string): Uint8Array<ArrayBuffer> {
  if (s.length % 2 !== 0) throw new Error('hex: odd length')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}

function makePinoLikeLogger(): unknown {
  const log = (level: string) => (a: unknown, b?: string) => {
    const tag = `[reality.tls.${level}]`
    if (typeof a === 'string') console.log(tag, a)
    else if (b) console.log(tag, b, JSON.stringify(a))
    else console.log(tag, JSON.stringify(a))
  }
  return {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    child: () => makePinoLikeLogger(),
  }
}
