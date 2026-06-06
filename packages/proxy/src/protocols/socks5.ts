// SOCKS5 client (TCP CONNECT only).
//
// We avoid `socket.startTls()` because of the workerd #2712 edge bug. After
// the SOCKS5 handshake we hand the post-handshake byte stream to userspace
// TLS for the upstream's HTTPS handshake.

import { getSocketDial } from '@floway-dev/platform'
import { runHttp1Stream } from '../http1-stream.js'
import { userspaceTls } from '../tls.js'
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js'

export interface Socks5Options {
  proxyHost: string
  proxyPort: number
  auth?: { username: string; password: string }
  target: TargetSpec
}

export async function runSocks5(opts: Socks5Options): Promise<Response> {
  const { proxyHost, proxyPort, auth, target } = opts
  const socket = await getSocketDial().connect(proxyHost, proxyPort, { allowHalfOpen: true })

  const writer = socket.writable.getWriter()

  const { readable: postHandshake, writable: forward } = new TransformStream<Uint8Array, Uint8Array>()
  const fwdWriter = forward.getWriter()
  const reader = socket.readable.getReader()

  let pending = new Uint8Array(0)
  const expect = async (n: number): Promise<Uint8Array> => {
    while (pending.byteLength < n) {
      const r = await reader.read()
      if (r.done) throw new Error(`SOCKS5: unexpected EOF, want ${n} got ${pending.byteLength}`)
      const next = new Uint8Array(pending.byteLength + r.value.byteLength)
      next.set(pending, 0)
      next.set(r.value, pending.byteLength)
      pending = next
    }
    const out = pending.subarray(0, n)
    pending = pending.subarray(n)
    return out
  }

  // 1. Greeting
  const methods = auth ? [0x00, 0x02] : [0x00]
  await writer.write(new Uint8Array([0x05, methods.length, ...methods]))

  const sel = await expect(2)
  if (sel[0] !== 0x05) throw new Error(`SOCKS5 bad version in method-select: ${sel[0]}`)
  if (sel[1] === 0xff) throw new Error('SOCKS5 no acceptable methods')
  if (sel[1] !== 0x00 && sel[1] !== 0x02) throw new Error(`SOCKS5 unexpected method: ${sel[1]}`)

  // 2. User/pass sub-negotiation
  if (sel[1] === 0x02) {
    if (!auth) throw new Error('SOCKS5 server demanded user/pass but no creds')
    const enc = new TextEncoder()
    const u = enc.encode(auth.username)
    const p = enc.encode(auth.password)
    if (u.byteLength > 255 || p.byteLength > 255) throw new Error('SOCKS5 cred too long')
    const greet = new Uint8Array(3 + u.byteLength + p.byteLength)
    let off = 0
    greet[off++] = 0x01
    greet[off++] = u.byteLength
    greet.set(u, off); off += u.byteLength
    greet[off++] = p.byteLength
    greet.set(p, off); off += p.byteLength
    await writer.write(greet)
    const reply = await expect(2)
    if (reply[0] !== 0x01) throw new Error(`SOCKS5 auth bad version: ${reply[0]}`)
    if (reply[1] !== 0x00) throw new Error(`SOCKS5 auth failed status=${reply[1]}`)
  }

  // 3. CONNECT request (ATYP=domain)
  const enc = new TextEncoder()
  const dom = enc.encode(target.dialHost)
  if (dom.byteLength > 255) throw new Error('hostname too long for SOCKS5')
  const req = new Uint8Array(7 + dom.byteLength)
  req[0] = 0x05
  req[1] = 0x01
  req[2] = 0x00
  req[3] = 0x03
  req[4] = dom.byteLength
  req.set(dom, 5)
  req[5 + dom.byteLength] = (target.port >> 8) & 0xff
  req[6 + dom.byteLength] = target.port & 0xff
  await writer.write(req)

  // 4. Reply: 4-byte fixed prefix, then variable BND.ADDR + 2-byte BND.PORT
  const head = await expect(4)
  if (head[0] !== 0x05) throw new Error(`SOCKS5 reply bad version: ${head[0]}`)
  if (head[1] !== 0x00) throw new Error(`SOCKS5 connect failed status=${head[1]}`)
  let bndLen = 0
  const atyp = head[3]
  if (atyp === 0x01) bndLen = 4
  else if (atyp === 0x04) bndLen = 16
  else if (atyp === 0x03) {
    const lenBuf = await expect(1)
    bndLen = lenBuf[0]!
  } else throw new Error(`SOCKS5 reply unknown ATYP: ${atyp}`)
  await expect(bndLen + 2)

  // 5. Forward any leftover bytes from the handshake reader to the post-handshake stream
  if (pending.byteLength) await fwdWriter.write(copy(pending))

  writer.releaseLock()

  // Pump remaining transport bytes into the forward stream
  ;(async () => {
    try {
      while (true) {
        const r = await reader.read()
        if (r.done) {
          try { await fwdWriter.close() } catch {}
          return
        }
        await fwdWriter.write(copy(r.value))
      }
    } catch (e) {
      fwdWriter.abort(e).catch(() => {})
    }
  })()

  if (target.tls) {
    const transport = { readable: postHandshake, writable: socket.writable }
    const tls = await userspaceTls(transport, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target) })
    return await runHttp1Stream(tls, target)
  } else {
    return await runHttp1Stream({ readable: postHandshake, writable: socket.writable }, target)
  }
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength)
  r.set(u)
  return r
}
