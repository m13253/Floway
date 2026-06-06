// Shared VLESS core: write VLESS header + strip server reply prefix + layer
// userspace TLS for the upstream HTTPS handshake.
//
// Used by reality.ts (after the REALITY-tls is established) and could be
// reused by vless.ts in a refactor.

import { runHttp1Stream } from '../http1-stream.js'
import { userspaceTls } from '../userspace-tls.js'
import { type TargetSpec } from '../targets.js'

export async function runVlessCoreOverStream(
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  uuid: string,
  target: TargetSpec,
): Promise<Response> {
  const header = buildVlessHeader(uuid, target)
  const writer = transport.writable.getWriter()
  await writer.write(header)
  writer.releaseLock()

  const stripped = stripVlessReplyPrefix(transport.readable)

  if (target.tls) {
    const tls = await userspaceTls(
      { readable: stripped, writable: transport.writable },
      { host: target.host },
    )
    return await runHttp1Stream(tls, target)
  } else {
    return await runHttp1Stream({ readable: stripped, writable: transport.writable }, target)
  }
}

function buildVlessHeader(uuid: string, target: TargetSpec): Uint8Array {
  const enc = new TextEncoder()
  const dom = enc.encode(target.host)
  if (dom.byteLength > 255) throw new Error('VLESS: hostname too long')
  const uuidBytes = parseUuid(uuid)
  const header = new Uint8Array(1 + 16 + 1 + 0 + 1 + 2 + 1 + 1 + dom.byteLength)
  let off = 0
  header[off++] = 0x00
  header.set(uuidBytes, off); off += 16
  header[off++] = 0x00
  header[off++] = 0x01
  header[off++] = (target.port >> 8) & 0xff
  header[off++] = target.port & 0xff
  header[off++] = 0x02
  header[off++] = dom.byteLength
  header.set(dom, off)
  return header
}

function parseUuid(s: string): Uint8Array {
  const hex = s.replace(/-/g, '')
  if (hex.length !== 32) throw new Error('bad UUID')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function stripVlessReplyPrefix(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let stripped = false
  let buf = new Uint8Array(0)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stripped) {
        while (buf.byteLength < 2) {
          const r = await reader.read()
          if (r.done) {
            controller.error(new Error('VLESS reply: EOF before prefix'))
            return
          }
          buf = concat(buf, r.value)
        }
        const addonsLen = buf[1]!
        while (buf.byteLength < 2 + addonsLen) {
          const r = await reader.read()
          if (r.done) {
            controller.error(new Error('VLESS reply: EOF in addons'))
            return
          }
          buf = concat(buf, r.value)
        }
        stripped = true
        const remainder = copy(buf.subarray(2 + addonsLen))
        if (remainder.byteLength) {
          controller.enqueue(remainder)
          return
        }
      }
      const r = await reader.read()
      if (r.done) controller.close()
      else controller.enqueue(copy(r.value))
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(a.byteLength + b.byteLength)
  r.set(a, 0)
  r.set(b, a.byteLength)
  return r
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength)
  r.set(u)
  return r
}
