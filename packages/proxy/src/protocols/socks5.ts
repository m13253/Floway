// SOCKS5 client (TCP CONNECT only).
//
// We avoid `socket.startTls()` because of the workerd #2712 edge bug. After
// the SOCKS5 handshake we hand the post-handshake byte stream back to the
// orchestrator, which layers userspace TLS for the upstream's HTTPS handshake.

import { copy, parseIpv4Literal, parseIpv6Literal } from '../bytes.ts';
import { ProxyDialError } from '../errors.ts';
import type { Socks5ProxyConfig } from '../proxy-config.ts';
import { assertValidTargetPort } from '../types.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';

export const dialSocks5 = async (
  config: Socks5ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'SOCKS5');

  const auth = config.username !== undefined
    ? { username: config.username, password: config.password ?? '' }
    : undefined;

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
    return await dialSocks5Inner(socket, auth, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialSocks5Inner = async (
  socket: DialedSocket,
  auth: { username: string; password: string } | undefined,
  target: DialTarget,
): Promise<DialResult> => {
  const writer = socket.writable.getWriter();

  const { readable: postHandshake, writable: forward } = new TransformStream<Uint8Array, Uint8Array>();
  const fwdWriter = forward.getWriter();
  const reader = socket.readable.getReader();

  let pending = new Uint8Array(0);
  const expect = async (n: number): Promise<Uint8Array> => {
    while (pending.byteLength < n) {
      const r = await reader.read();
      if (r.done) throw new ProxyDialError(`SOCKS5: unexpected EOF, want ${n} got ${pending.byteLength}`, 'proxy-handshake');
      const next = new Uint8Array(pending.byteLength + r.value.byteLength);
      next.set(pending, 0);
      next.set(r.value, pending.byteLength);
      pending = next;
    }
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };

  // 1. Greeting
  const methods = auth ? [0x00, 0x02] : [0x00];
  await writer.write(new Uint8Array([0x05, methods.length, ...methods]));

  const sel = await expect(2);
  if (sel[0] !== 0x05) throw new ProxyDialError(`SOCKS5 bad version in method-select: ${sel[0]}`, 'proxy-handshake');
  if (sel[1] === 0xff) throw new ProxyDialError('SOCKS5 no acceptable methods', 'proxy-handshake');
  if (sel[1] !== 0x00 && sel[1] !== 0x02) throw new ProxyDialError(`SOCKS5 unexpected method: ${sel[1]}`, 'proxy-handshake');

  // 2. User/pass sub-negotiation
  if (sel[1] === 0x02) {
    if (!auth) throw new ProxyDialError('SOCKS5 server demanded user/pass but no creds', 'proxy-handshake');
    const enc = new TextEncoder();
    const u = enc.encode(auth.username);
    const p = enc.encode(auth.password);
    if (u.byteLength > 255 || p.byteLength > 255) throw new ProxyDialError('SOCKS5 cred too long', 'proxy-handshake');
    const greet = new Uint8Array(3 + u.byteLength + p.byteLength);
    let off = 0;
    greet[off++] = 0x01;
    greet[off++] = u.byteLength;
    greet.set(u, off); off += u.byteLength;
    greet[off++] = p.byteLength;
    greet.set(p, off); off += p.byteLength;
    await writer.write(greet);
    const reply = await expect(2);
    if (reply[0] !== 0x01) throw new ProxyDialError(`SOCKS5 auth bad version: ${reply[0]}`, 'proxy-handshake');
    if (reply[1] !== 0x00) throw new ProxyDialError(`SOCKS5 auth failed status=${reply[1]}`, 'proxy-handshake');
  }

  // 3. CONNECT request. Literal IPv4 / IPv6 targets are emitted as raw
  //    octets (ATYP=0x01 / 0x04) so the SOCKS5 server doesn't have to
  //    re-parse a string into an address — same shape Xray-core / sing-box
  //    send for literal targets. Domain hostnames take the length-prefixed
  //    ATYP=0x03 path.
  const req = buildSocks5ConnectRequest(target.host, target.port);
  await writer.write(req);

  // 4. Reply: 4-byte fixed prefix, then variable BND.ADDR + 2-byte BND.PORT
  const head = await expect(4);
  if (head[0] !== 0x05) throw new ProxyDialError(`SOCKS5 reply bad version: ${head[0]}`, 'proxy-handshake');
  if (head[1] !== 0x00) throw new ProxyDialError(`SOCKS5 connect failed status=${head[1]}`, 'proxy-handshake');
  // RFC 1928 §6: RSV MUST be 0x00. A non-zero byte points at a broken or
  // hostile proxy and we'd rather surface the spec violation than parse
  // an ambiguous reply.
  if (head[2] !== 0x00) throw new ProxyDialError(`SOCKS5 reply RSV byte non-zero (got 0x${head[2]!.toString(16).padStart(2, '0')}, RFC 1928 §6)`, 'proxy-handshake');
  let bndLen = 0;
  const atyp = head[3];
  if (atyp === 0x01) bndLen = 4;
  else if (atyp === 0x04) bndLen = 16;
  else if (atyp === 0x03) {
    const lenBuf = await expect(1);
    bndLen = lenBuf[0]!;
  } else throw new ProxyDialError(`SOCKS5 reply unknown ATYP: ${atyp}`, 'proxy-handshake');
  await expect(bndLen + 2);

  // 5. Forward any leftover bytes from the handshake reader to the post-handshake stream
  if (pending.byteLength) await fwdWriter.write(copy(pending));

  writer.releaseLock();

  // Pump remaining transport bytes into the forward stream. The dial's
  // outer try/catch has already exited by the time this runs, so on error
  // we ALSO close the socket — the orchestrator only holds wrapper streams
  // and has no way to reach the raw fd otherwise.
  void (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) {
          try { await fwdWriter.close(); } catch { /* fwd already closed */ }
          return;
        }
        await fwdWriter.write(copy(r.value));
      }
    } catch (e) {
      fwdWriter.abort(e).catch(() => {});
      void socket.close().catch(() => {});
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();

  return { readable: postHandshake, writable: socket.writable };
};

/**
 * Build a SOCKS5 CONNECT request frame for `host:port`. Literal IPv4 /
 * IPv6 targets serialize as ATYP=0x01 (4 raw octets) / 0x04 (16 raw
 * octets); a true hostname takes ATYP=0x03 (1-byte length + bytes).
 * Non-ASCII hostnames are rejected up-front — the dial layer's contract
 * (see `DialTarget.host`) is ASCII-only and callers must punycode IDN
 * labels before they reach here.
 *
 * Exported for tests.
 */
export const buildSocks5ConnectRequest = (host: string, port: number): Uint8Array => {
  assertValidTargetPort(port, 'SOCKS5');
  // Strip the optional IPv6 brackets so callers can pass either
  // `2001:db8::1` or `[2001:db8::1]`.
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = parseIpv4Literal(host);
  if (v4) {
    const out = new Uint8Array(4 + 4 + 2);
    out[0] = 0x05; out[1] = 0x01; out[2] = 0x00; out[3] = 0x01;
    out.set(v4, 4);
    out[8] = (port >> 8) & 0xff;
    out[9] = port & 0xff;
    return out;
  }
  const v6 = parseIpv6Literal(unbracketed);
  if (v6) {
    const out = new Uint8Array(4 + 16 + 2);
    out[0] = 0x05; out[1] = 0x01; out[2] = 0x00; out[3] = 0x04;
    out.set(v6, 4);
    out[20] = (port >> 8) & 0xff;
    out[21] = port & 0xff;
    return out;
  }
  for (let i = 0; i < host.length; i++) {
    if (host.charCodeAt(i) > 0x7f) {
      throw new ProxyDialError(
        `SOCKS5 target host must be ASCII (punycode IDN before dial): ${host}`,
        'proxy-handshake',
      );
    }
  }
  const dom = new TextEncoder().encode(host);
  if (dom.byteLength > 255) throw new ProxyDialError('hostname too long for SOCKS5', 'proxy-handshake');
  const out = new Uint8Array(4 + 1 + dom.byteLength + 2);
  out[0] = 0x05; out[1] = 0x01; out[2] = 0x00; out[3] = 0x03;
  out[4] = dom.byteLength;
  out.set(dom, 5);
  out[5 + dom.byteLength] = (port >> 8) & 0xff;
  out[6 + dom.byteLength] = port & 0xff;
  return out;
};
