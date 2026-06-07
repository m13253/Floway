// Shared VLESS core: write VLESS header + strip server reply prefix + layer
// userspace TLS for the upstream HTTPS handshake.
//
// Used by reality.ts (after the REALITY-tls is established).

import { ProxyDialError } from '../errors.js';
import { runHttp1 } from '../http1.js';
import { userspaceTls, type TlsStream } from '../tls.js';
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js';

export async function runVlessCoreOverStream(
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  uuid: string,
  target: TargetSpec,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const header = buildVlessHeader(uuid, target);
  const writer = transport.writable.getWriter();
  await writer.write(header);
  writer.releaseLock();

  const stripped = stripVlessReplyPrefix(transport.readable);

  if (target.tls) {
    let tls: TlsStream;
    try {
      tls = await userspaceTls(
        { readable: stripped, writable: transport.writable },
        { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target), signal },
      );
    } catch (cause) {
      // The reply-prefix strip can surface a typed ProxyDialError
      // (e.g. bad version byte) through the readable that userspaceTls
      // consumes. Preserve it so the dial layer's stage-aware backoff
      // classifies it as `proxy-handshake` instead of `inner-tls`.
      if (cause instanceof ProxyDialError) throw cause;
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return await runHttp1(tls, target);
  } else {
    return await runHttp1({ readable: stripped, writable: transport.writable }, target);
  }
}

function buildVlessHeader(uuid: string, target: TargetSpec): Uint8Array {
  const enc = new TextEncoder();
  const dom = enc.encode(target.dialHost);
  if (dom.byteLength > 255) throw new ProxyDialError('VLESS: hostname too long', 'proxy-handshake');
  const uuidBytes = parseUuid(uuid);
  const header = new Uint8Array(1 + 16 + 1 + 0 + 1 + 2 + 1 + 1 + dom.byteLength);
  let off = 0;
  header[off++] = 0x00;
  header.set(uuidBytes, off); off += 16;
  header[off++] = 0x00;
  header[off++] = 0x01;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header[off++] = 0x02;
  header[off++] = dom.byteLength;
  header.set(dom, off);
  return header;
}

function parseUuid(s: string): Uint8Array {
  const hex = s.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new ProxyDialError(`VLESS: malformed UUID ${JSON.stringify(s)}`, 'proxy-handshake');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function stripVlessReplyPrefix(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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
        // Same fail-closed check as runVlessTcpInner — fail with a typed
        // proxy-handshake error rather than letting non-VLESS bytes flow into
        // the inner TLS handshake and surface as an opaque TLS failure.
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
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
}
