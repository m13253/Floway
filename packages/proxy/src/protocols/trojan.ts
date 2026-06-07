// Trojan client.
//
// We do BOTH the outer TLS (to the Trojan server) and the inner TLS (to the
// upstream HTTPS) in userspace, because workerd's outer TLS implementation
// splits the first application-data write into two TLS records (~4 bytes +
// rest). sing-box's trojan inbound reads the 56-byte key with `conn.Read`,
// which short-reads on the 4-byte first record and rejects with
// "bad request size: fallback disabled". Doing the outer TLS in userspace
// gives us full control of record framing.
//
// The Trojan request header (56-byte hex(SHA-224(password)) + CRLF + SOCKS-
// like address) MUST land in the same record as the first inner-protocol
// bytes — the inner-TLS ClientHello when target.tls=true, or the HTTP/1.1
// request line when target.tls=false. We surface the header as `prefix` on
// the DialResult so the orchestrator passes it to whichever wrapper consumes
// the next bytes (userspaceTls.prefix or fetchOnStream.prefix).

import { sha224 } from '@noble/hashes/sha2.js';

import { ProxyDialError } from '../errors.ts';
import type { TrojanProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { userspaceTls, type TlsStream } from '@floway-dev/http';

export const dialTrojan = async (
  config: TrojanProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  // Plain TCP to Trojan server; outer TLS done in userspace.
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
    return await dialTrojanInner(socket, config, target, options.signal);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialTrojanInner = async (
  socket: DialedSocket,
  config: TrojanProxyConfig,
  target: DialTarget,
  signal: AbortSignal | undefined,
): Promise<DialResult> => {
  let outerTls: TlsStream;
  try {
    outerTls = await userspaceTls(socket, { host: config.sni ?? config.host, signal });
  } catch (cause) {
    throw new ProxyDialError('outer tls handshake to trojan server failed', 'outer-tls', { cause });
  }

  const enc = new TextEncoder();
  const hash = sha224(enc.encode(config.password));
  const hashHex = bytesToHex(hash);

  const dom = enc.encode(target.host);
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

  return {
    readable: outerTls.readable,
    writable: outerTls.writable,
    prefix: header,
  };
};

const bytesToHex = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};
