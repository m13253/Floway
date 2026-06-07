// Trojan client.
//
// We do BOTH the outer TLS (to the Trojan server) and the inner TLS (to the
// upstream HTTPS) in userspace, because workerd's outer TLS implementation
// splits the first application-data write into two TLS records (~4 bytes +
// rest). sing-box's trojan inbound reads the 56-byte key with `conn.Read`,
// which short-reads on the 4-byte first record and rejects with
// "bad request size: fallback disabled". Doing the outer TLS in userspace
// gives us full control of record framing.

import { sha224 } from '@noble/hashes/sha2.js';

import { ProxyDialError } from '../errors.js';
import { runHttp1 } from '../http1.js';
import { userspaceTls, type TlsStream } from '../tls.js';
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js';
import { type DialedSocket, getSocketDial } from '@floway-dev/platform';

export interface TrojanOptions {
  serverHost: string;
  serverPort: number;
  password: string;
  target: TargetSpec;
}

export async function runTrojan(opts: TrojanOptions): Promise<Response> {
  const { serverHost, serverPort, password, target } = opts;

  // Plain TCP to Trojan server; outer TLS done in userspace.
  let socket: DialedSocket;
  try {
    socket = await getSocketDial().connect(serverHost, serverPort, { allowHalfOpen: true });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${serverHost}:${serverPort} failed`,
      'tcp-connect',
      { cause },
    );
  }
  let outerTls: TlsStream;
  try {
    outerTls = await userspaceTls(socket, { host: serverHost });
  } catch (cause) {
    throw new ProxyDialError('outer tls handshake to trojan server failed', 'outer-tls', { cause });
  }

  const enc = new TextEncoder();
  const hash = sha224(enc.encode(password));
  const hashHex = bytesToHex(hash);

  const dom = enc.encode(target.dialHost);
  if (dom.byteLength > 255) throw new ProxyDialError('hostname too long for Trojan', 'proxy-handshake');
  const header = new Uint8Array(56 + 2 + 1 + 1 + 1 + dom.byteLength + 2 + 2);
  let off = 0;
  for (let i = 0; i < 56; i++) header[off++] = hashHex.charCodeAt(i);
  header[off++] = 0x0d; header[off++] = 0x0a;
  header[off++] = 0x01;
  header[off++] = 0x03;
  header[off++] = dom.byteLength;
  header.set(dom, off); off += dom.byteLength;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header[off++] = 0x0d; header[off++] = 0x0a;

  if (target.tls) {
    let innerTls: TlsStream;
    try {
      innerTls = await userspaceTls(outerTls, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target), prefix: header });
    } catch (cause) {
      // The Trojan header rides as the prefix bytes of the inner TLS
      // ClientHello, so a server-side password rejection or a real upstream
      // TLS failure both surface here. We can't tell them apart without
      // sniffing the inner record framing — flag both as inner-tls.
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return await runHttp1(innerTls, target);
  } else {
    const writer = outerTls.writable.getWriter();
    await writer.write(header);
    writer.releaseLock();
    return await runHttp1(outerTls, target);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}
