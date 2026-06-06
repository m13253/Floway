// Trojan client.
//
// We do BOTH the outer TLS (to the Trojan server) and the inner TLS (to the
// upstream HTTPS) in userspace, because workerd's outer TLS implementation
// splits the first application-data write into two TLS records (~4 bytes +
// rest). sing-box's trojan inbound reads the 56-byte key with `conn.Read`,
// which short-reads on the 4-byte first record and rejects with
// "bad request size: fallback disabled". Doing the outer TLS in userspace
// gives us full control of record framing.

import { getSocketDial } from '@floway-dev/platform'
import { sha224 } from '@noble/hashes/sha2.js'
import { runHttp1Stream } from '../http1-stream.js'
import { userspaceTls } from '../tls.js'
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js'

export interface TrojanOptions {
  serverHost: string
  serverPort: number
  password: string
  target: TargetSpec
}

export async function runTrojan(opts: TrojanOptions): Promise<Response> {
  const { serverHost, serverPort, password, target } = opts

  // Plain TCP to Trojan server; outer TLS done in userspace.
  const socket = await getSocketDial().connect(serverHost, serverPort, { allowHalfOpen: true })
  const outerTls = await userspaceTls(socket, { host: serverHost })

  const enc = new TextEncoder()
  const hash = sha224(enc.encode(password))
  const hashHex = bytesToHex(hash)

  const dom = enc.encode(target.dialHost)
  if (dom.byteLength > 255) throw new Error('hostname too long for Trojan')
  const header = new Uint8Array(56 + 2 + 1 + 1 + 1 + dom.byteLength + 2 + 2)
  let off = 0
  for (let i = 0; i < 56; i++) header[off++] = hashHex.charCodeAt(i)
  header[off++] = 0x0d; header[off++] = 0x0a
  header[off++] = 0x01
  header[off++] = 0x03
  header[off++] = dom.byteLength
  header.set(dom, off); off += dom.byteLength
  header[off++] = (target.port >> 8) & 0xff
  header[off++] = target.port & 0xff
  header[off++] = 0x0d; header[off++] = 0x0a

  if (target.tls) {
    const innerTls = await userspaceTls(outerTls, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target), prefix: header })
    return await runHttp1Stream(innerTls, target)
  } else {
    const writer = outerTls.writable.getWriter()
    await writer.write(header)
    writer.releaseLock()
    return await runHttp1Stream(outerTls, target)
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}
