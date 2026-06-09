// RFC 6455 vectors covering the upgrade handshake (accept-key validation,
// non-101 reject, missing/wrong accept reject), the frame parser
// (length-form boundaries, control-frame skip, ping→pong roundtrip,
// rejection of masked server frames), and a full wire-byte round-trip
// where a fake server completes the handshake, sends a small frame, and
// the client surfaces the unmasked payload to its consumer.

import { sha1 } from '@noble/hashes/legacy.js';
import { describe, expect, it } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { wsUpgradeAndFrame } from './ws-upgrade.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const base64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

const parseUpgradeRequest = (raw: Uint8Array): { method: string; path: string; headers: Map<string, string> } => {
  const text = dec(raw);
  const idx = text.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error('upgrade request not terminated');
  const lines = text.slice(0, idx).split('\r\n');
  const [method, path] = lines.shift()!.split(' ');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const c = line.indexOf(':');
    headers.set(line.slice(0, c).toLowerCase(), line.slice(c + 1).trim());
  }
  return { method: method!, path: path!, headers };
};

const buildAcceptHeader = (clientKey: string): string => base64(sha1(enc(clientKey + WS_GUID)));

const standardHandshakeReply = (clientKey: string, extra: string = ''): string => {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${buildAcceptHeader(clientKey)}`,
    extra,
    '',
    '',
  ].filter((l, i, arr) => !(i === arr.length - 3 && l === '')).join('\r\n');
};

const buildServerFrame = (
  opcode: number,
  payload: Uint8Array,
  fin: boolean = true,
): Uint8Array => {
  const len = payload.byteLength;
  let header: number[];
  if (len <= 125) {
    header = [(fin ? 0x80 : 0) | opcode, len];
  } else if (len <= 0xffff) {
    header = [(fin ? 0x80 : 0) | opcode, 126, (len >> 8) & 0xff, len & 0xff];
  } else {
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    header = [
      (fin ? 0x80 : 0) | opcode, 127,
      (hi >> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    ];
  }
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(payload, header.length);
  return out;
};

// Strip the mask + reveal the (opcode, fin, payload) of one client frame.
const parseClientFrame = (
  buf: Uint8Array,
): { opcode: number; fin: boolean; payload: Uint8Array; consumed: number } | null => {
  if (buf.byteLength < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  if (!masked) throw new Error('client frame is not masked');
  const len7 = buf[1]! & 0x7f;
  let off = 2;
  let payloadLen: number;
  if (len7 <= 125) {
    payloadLen = len7;
  } else if (len7 === 126) {
    if (buf.byteLength < 4) return null;
    payloadLen = (buf[2]! << 8) | buf[3]!;
    off = 4;
  } else {
    if (buf.byteLength < 10) return null;
    let n = 0;
    for (let i = 0; i < 8; i++) n = (n * 256) + buf[2 + i]!;
    payloadLen = n;
    off = 10;
  }
  if (buf.byteLength < off + 4 + payloadLen) return null;
  const maskKey = buf.subarray(off, off + 4);
  const masked_payload = buf.subarray(off + 4, off + 4 + payloadLen);
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] = masked_payload[i]! ^ maskKey[i & 3]!;
  return { opcode, fin, payload, consumed: off + 4 + payloadLen };
};

describe('wsUpgradeAndFrame — handshake', () => {
  it('sends a valid GET … HTTP/1.1 upgrade with a fresh 16-byte base64 key', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'vless.local', path: '/ws' });
    // give the request bytes time to land
    await new Promise(r => setTimeout(r, 0));
    const written = fake.written();
    const req = parseUpgradeRequest(written);
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/ws');
    expect(req.headers.get('host')).toBe('vless.local');
    expect(req.headers.get('upgrade')).toBe('websocket');
    expect(req.headers.get('connection')).toBe('Upgrade');
    expect(req.headers.get('sec-websocket-version')).toBe('13');
    const key = req.headers.get('sec-websocket-key')!;
    // Base64 of 16 bytes is 24 characters with `=` padding.
    expect(key).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    // Decode and check raw length is 16.
    const raw = atob(key);
    expect(raw.length).toBe(16);
    fake.respond(standardHandshakeReply(key));
    fake.endResponse();
    await upgrade;
  });

  it('accepts a 101 with the right Sec-WebSocket-Accept', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond(standardHandshakeReply(key));
    await upgrade;
  });

  it('rejects a non-101 status', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    await expect(upgrade).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'BAD_STATUS_LINE',
      message: expect.stringContaining('403'),
    });
  });

  it('rejects a missing Sec-WebSocket-Accept header', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Sec-WebSocket-Accept'),
    });
  });

  it('rejects a wrong Sec-WebSocket-Accept value', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Sec-WebSocket-Accept mismatch'),
    });
  });

  it('rejects a missing Upgrade: websocket header', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${buildAcceptHeader(key)}`,
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Upgrade'),
    });
  });

  it('rejects a server-selected subprotocol the client did not offer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, {
      host: 'h',
      path: '/',
      subprotocols: ['chat'],
    });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${buildAcceptHeader(key)}`,
      'Sec-WebSocket-Protocol: superchat',
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('superchat'),
    });
  });

  it('rejects a caller attempt to override Host', async () => {
    const fake = makeFakeDuplex();
    await expect(wsUpgradeAndFrame(fake, {
      host: 'h',
      path: '/',
      additionalHeaders: { Host: 'other.example' },
    })).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('reserved'),
    });
  });
});

describe('wsUpgradeAndFrame — frame layer round-trip', () => {
  const completeHandshake = async (fake: ReturnType<typeof makeFakeDuplex>): Promise<void> => {
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond(standardHandshakeReply(key));
  };

  // Read one client frame off `fake.written()` past any bytes already
  // consumed by the test. Returns the parsed frame and the new `seen`
  // pointer so the next call skips what's already parsed.
  const readClientFrame = async (
    fake: ReturnType<typeof makeFakeDuplex>,
    seen: number,
  ): Promise<{ frame: ReturnType<typeof parseClientFrame>; seen: number }> => {
    while (true) {
      const written = fake.written().subarray(seen);
      const f = parseClientFrame(written);
      if (f) return { frame: f, seen: seen + f.consumed };
      await new Promise(r => setTimeout(r, 5));
    }
  };

  it('round-trips a single small binary frame from server to consumer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x2, enc('hello world')));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(dec(value!)).toBe('hello world');
    reader.releaseLock();
  });

  it('writes a single client message as one masked binary frame', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    await writer.write(enc('ping'));
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.opcode).toBe(0x2);
    expect(frame!.fin).toBe(true);
    expect(dec(frame!.payload)).toBe('ping');
    writer.releaseLock();
  });

  it('responds to a server ping with a pong of the same payload', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    await upgrade;
    const handshakeBytes = fake.written().byteLength;
    fake.respond(buildServerFrame(0x9, enc('ping-payload')));
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.opcode).toBe(0xa);
    expect(dec(frame!.payload)).toBe('ping-payload');
  });

  it('rejects a masked server-to-client frame', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    // Build a binary frame that happens to claim MASK=1 with a 4-byte key.
    const payload = enc('hi');
    const out = new Uint8Array(2 + 4 + payload.byteLength);
    out[0] = 0x82;
    out[1] = 0x80 | payload.byteLength;
    out.set([0, 0, 0, 0], 2);
    out.set(payload, 6);
    fake.respond(out);
    const reader = stream.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('masked'),
    });
  });

  it('reassembles a fragmented binary message before surfacing to the consumer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x2, enc('hello '), false));
    fake.respond(buildServerFrame(0x0, enc('world'), true));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(dec(value!)).toBe('hello world');
    reader.releaseLock();
  });

  it('handles a frame that crosses the 16-bit length boundary', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(200);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(200);
    expect(value![0]).toBe(0);
    expect(value![199]).toBe(199);
    reader.releaseLock();
  });

  it('handles a frame at exactly the 7-bit length boundary (125 bytes)', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(125);
    for (let i = 0; i < 125; i++) payload[i] = i & 0xff;
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(125);
    reader.releaseLock();
  });

  it('handles the smallest 16-bit length frame (126 bytes)', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(126);
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(126);
    reader.releaseLock();
  });

  it('writes a payload that crosses the 16-bit length boundary using the 16-bit form', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    const payload = new Uint8Array(500);
    for (let i = 0; i < 500; i++) payload[i] = i & 0xff;
    await writer.write(payload);
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.payload.byteLength).toBe(500);
    expect(frame!.payload[0]).toBe(0);
    expect(frame!.payload[499]).toBe(499 & 0xff);
    writer.releaseLock();
  });

  it('writes a payload above 64 KiB using the 64-bit form', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    const payload = new Uint8Array(70_000);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
    await writer.write(payload);
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.payload.byteLength).toBe(70_000);
    expect(frame!.payload[0]).toBe(0);
    expect(frame!.payload[69_999]).toBe(69_999 & 0xff);
    // Spot-check a couple of mid-range bytes to confirm masking is sound.
    expect(frame!.payload[12345]).toBe(12345 & 0xff);
    writer.releaseLock();
  });

  it('a server close frame ends the consumer readable cleanly', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x8, new Uint8Array([0x03, 0xe8]))); // 1000
    const reader = stream.readable.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
    reader.releaseLock();
  });
});
