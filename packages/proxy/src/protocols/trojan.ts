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

import { parseIpv4Literal, parseIpv6Literal } from '../bytes.ts';
import { ProxyDialError } from '../errors.ts';
import type { TrojanProxyConfig } from '../proxy-config.ts';
import { assertValidTargetPort } from '../types.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { userspaceTls, type TlsStream } from '@floway-dev/http';

export const dialTrojan = async (
  config: TrojanProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  // Hoist port-range validation ahead of socketDial.connect so a bad
  // target port doesn't burn a TCP slot to the proxy server.
  assertValidTargetPort(target.port, 'Trojan');
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

  const header = buildTrojanRequestHeader(config.password, target);

  return {
    readable: outerTls.readable,
    writable: outerTls.writable,
    prefix: header,
  };
};

/**
 * Trojan request header (exported for tests).
 *
 *   hex(SHA-224(password))[56] | CRLF | CMD=0x01 | ATYP | addr | port[BE] | CRLF
 *
 * ATYP follows the SOCKS5 numbering (0x01 IPv4 raw, 0x03 domain
 * length-prefixed, 0x04 IPv6 raw). Reference clients detect literal IPs
 * and send them as raw octets; only true hostnames take the domain path.
 *
 * Spec: https://trojan-gfw.github.io/trojan/protocol
 */
export const buildTrojanRequestHeader = (password: string, target: DialTarget): Uint8Array => {
  assertValidTargetPort(target.port, 'Trojan');
  const enc = new TextEncoder();
  const hash = sha224(enc.encode(password));
  const hashHex = bytesToHex(hash);

  const addr = encodeTrojanAddress(target.host);
  const header = new Uint8Array(56 + 2 + 1 + addr.byteLength + 2 + 2);
  let off = 0;
  for (let i = 0; i < 56; i++) header[off++] = hashHex.charCodeAt(i);
  header[off++] = 0x0d; header[off++] = 0x0a;
  header[off++] = 0x01;
  header.set(addr, off); off += addr.byteLength;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header[off++] = 0x0d; header[off++] = 0x0a;
  return header;
};

const encodeTrojanAddress = (host: string): Uint8Array => {
  // Strip the optional IPv6 brackets so callers can pass either
  // `2001:db8::1` or `[2001:db8::1]`.
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = parseIpv4Literal(host);
  if (v4) {
    const out = new Uint8Array(1 + 4);
    out[0] = 0x01;
    out.set(v4, 1);
    return out;
  }
  const v6 = parseIpv6Literal(unbracketed);
  if (v6) {
    const out = new Uint8Array(1 + 16);
    out[0] = 0x04;
    out.set(v6, 1);
    return out;
  }
  // Domain path. Trojan servers (trojan-gfw, sing-box) parse the domain
  // as UTF-8 in-band, but emitting raw Latin-1 / UTF-8 bytes for an IDN
  // label muddles wire framing — the caller has the information to
  // punycode before the dial.
  for (let i = 0; i < host.length; i++) {
    if (host.charCodeAt(i) > 0x7f) {
      throw new ProxyDialError(
        `Trojan target host must be ASCII (punycode IDN before dial): ${host}`,
        'proxy-handshake',
      );
    }
  }
  const dom = new TextEncoder().encode(host);
  if (dom.byteLength > 255) throw new ProxyDialError('hostname too long for Trojan', 'proxy-handshake');
  const out = new Uint8Array(1 + 1 + dom.byteLength);
  out[0] = 0x03;
  out[1] = dom.byteLength;
  out.set(dom, 2);
  return out;
};

const bytesToHex = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};
