// Shared VLESS core: write VLESS header to a transport, peel the server's
// reply prefix off the readable, and return the post-framing duplex stream.
//
// Used by reality.ts (after the REALITY-tls is established) and by vless.ts
// (after the outer TLS / outer fetch+WS upgrade).

import { concat, copy, hexDecode, parseIpv4Literal, parseIpv6Literal } from '../bytes.ts';
import { ProxyDialError } from '../errors.ts';
import { assertValidTargetPort } from '../types.ts';
import type { DialResult, DialTarget } from '../types.ts';

export const vlessFrameOverStream = async (
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  uuid: string,
  target: DialTarget,
): Promise<DialResult> => {
  const header = buildVlessHeader(uuid, target);
  const writer = transport.writable.getWriter();
  await writer.write(header);
  writer.releaseLock();

  const stripped = stripVlessReplyPrefix(transport.readable);

  return { readable: stripped, writable: transport.writable };
};

/**
 * VLESS request header.
 *
 *   ver=0x00 | UUID[16] | addonsLen=0 | cmd=0x01 (TCP)
 *     | port[BE] | ATYP | addr | payload…
 *
 * ATYP values (xtls.github.io/development/protocols/vless.html):
 *   0x01 IPv4 (4 raw octets)
 *   0x02 Domain (1-byte length + domain bytes)
 *   0x03 IPv6 (16 raw octets)
 *
 * Note the numbering is distinct from SOCKS5 / Shadowsocks (which use
 * 0x01 v4, 0x03 domain, 0x04 v6) — confusing the two encodings is the
 * exact failure mode this builder discriminates against.
 */
const buildVlessHeader = (uuid: string, target: DialTarget): Uint8Array => {
  assertValidTargetPort(target.port, 'VLESS');
  const uuidBytes = parseUuid(uuid);
  const addr = encodeVlessAddress(target.host);
  const header = new Uint8Array(1 + 16 + 1 + 0 + 1 + 2 + addr.byteLength);
  let off = 0;
  header[off++] = 0x00;
  header.set(uuidBytes, off); off += 16;
  header[off++] = 0x00;
  header[off++] = 0x01;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header.set(addr, off);
  return header;
};

const encodeVlessAddress = (host: string): Uint8Array => {
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
    out[0] = 0x03;
    out.set(v6, 1);
    return out;
  }
  // Domain path. VLESS servers (Xray-core, sing-box) parse the domain as
  // UTF-8 string in-band, but Latin-1 / UTF-8 framing of an IDN label on
  // the wire is a layering muddle — the caller has the information to
  // punycode an IDN before it reaches the dial layer. Reject non-ASCII
  // up front so the dial fails as a typed handshake error.
  for (let i = 0; i < host.length; i++) {
    if (host.charCodeAt(i) > 0x7f) {
      throw new ProxyDialError(
        `VLESS target host must be ASCII (punycode IDN before dial): ${host}`,
        'proxy-handshake',
      );
    }
  }
  const dom = new TextEncoder().encode(host);
  if (dom.byteLength > 255) throw new ProxyDialError('VLESS: hostname too long', 'proxy-handshake');
  const out = new Uint8Array(1 + 1 + dom.byteLength);
  out[0] = 0x02;
  out[1] = dom.byteLength;
  out.set(dom, 2);
  return out;
};

const parseUuid = (s: string): Uint8Array => {
  const hex = s.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    // UUIDs are VLESS credentials. Carry the raw value only on `cause` so it
    // stays out of the dial error's message — which lands in log lines, dial
    // metrics, and dashboard error strings.
    throw new ProxyDialError('VLESS: malformed UUID', 'proxy-handshake', { cause: { uuid: s } });
  }
  return hexDecode(hex);
};

const stripVlessReplyPrefix = (source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let stripped = false;
  let buf = new Uint8Array(0);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stripped) {
        while (buf.byteLength < 2) {
          const r = await reader.read();
          if (r.done) {
            controller.error(new ProxyDialError('VLESS reply: EOF before prefix', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        // Fail closed with a typed proxy-handshake error rather than letting
        // non-VLESS bytes flow into the inner TLS handshake and surface as
        // an opaque TLS failure.
        if (buf[0] !== 0x00) {
          controller.error(new ProxyDialError(`VLESS reply: bad version 0x${buf[0]!.toString(16)}`, 'proxy-handshake'));
          return;
        }
        const addonsLen = buf[1]!;
        while (buf.byteLength < 2 + addonsLen) {
          const r = await reader.read();
          if (r.done) {
            controller.error(new ProxyDialError('VLESS reply: EOF in addons', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        stripped = true;
        const remainder = copy(buf.subarray(2 + addonsLen));
        if (remainder.byteLength) {
          controller.enqueue(remainder);
          return;
        }
      }
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(copy(r.value));
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};
