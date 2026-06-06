// rustls-wasm based userspace TLS adapter.
//
// Wraps a duplex byte transport with a TLS 1.3 client built on rustls
// (via MercuryWorkshop/rustls-wasm). Compared to the @reclaimprotocol/tls
// path, AEAD work runs in WASM (ring chacha20/AES-GCM) which is ~10× faster
// than @noble/ciphers' pure-JS chacha. The bundle adds ~240 KiB gzip (WASM)
// + ~9 KiB gzip (JS glue).
//
// Workers requires WASM modules to be statically imported (the runtime
// disallows `WebAssembly.instantiate(buffer)` from arbitrary bytes). Wrangler
// handles `import wasm from './x.wasm'` as a static module, which we then
// pass into wasm-bindgen's init.

import wasmModule from '../vendor/rustls-wasm/dist/rustls.wasm'
import init, { connect_tls } from '../vendor/rustls-wasm/dist/rustls-bundled.js'
import { connect } from 'cloudflare:sockets'
import { runHttp1Stream } from './http1-stream.js'
import { type TargetSpec } from './targets.js'

let initialized: Promise<void> | null = null
function ensureInit(): Promise<void> {
  if (!initialized) initialized = init(wasmModule as unknown as WebAssembly.Module)
  return initialized
}

export interface RustlsTlsOptions {
  host: string
}

export async function userspaceTlsRustls(
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  opts: RustlsTlsOptions,
): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> {
  await ensureInit()
  // Pass through directly — workerd's socket.readable is BYOB-capable, so
  // rustls-wasm's `try_into_async_read()` should succeed without falling
  // through to its strict jsval_to_vec chunk converter.
  const out = (await connect_tls(
    transport.readable as unknown as ReadableStream,
    transport.writable as unknown as WritableStream,
    opts.host,
  )) as { read: ReadableStream<Uint8Array>; write: WritableStream<Uint8Array> }
  return { readable: out.read, writable: out.write }
}

export async function runRustlsDirect(target: TargetSpec): Promise<Response> {
  if (!target.tls) throw new Error('rustls-direct only valid for TLS targets')
  const sock = connect(
    { hostname: target.host, port: target.port },
    { secureTransport: 'off', allowHalfOpen: true },
  )
  const tls = await userspaceTlsRustls(sock, { host: target.sni ?? target.host })
  return await runHttp1Stream(tls, target)
}
