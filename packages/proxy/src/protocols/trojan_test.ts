import { describe, expect, it } from 'vitest';

import { buildTrojanRequestHeader } from './trojan.ts';
import type { DialTarget } from '../types.ts';

const target443: DialTarget = { host: 'api.openai.com', port: 443 };

const sha224HexOfPassword = 'password' as const;
// Reference: trojan-go/tunnel/trojan/server_test.go uses
// hex(SHA-224("password")) → "d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01"
const PASSWORD_SHA224_HEX = 'd63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01';

describe('buildTrojanRequestHeader', () => {
  it('starts with 56 bytes of hex(SHA-224(password)) followed by CRLF', () => {
    const header = buildTrojanRequestHeader(sha224HexOfPassword, target443);
    const hashAscii = new TextDecoder().decode(header.subarray(0, 56));
    expect(hashAscii).toBe(PASSWORD_SHA224_HEX);
    expect(header[56]).toBe(0x0d);
    expect(header[57]).toBe(0x0a);
  });

  it('encodes a SOCKS5-style domain target after the CRLF', () => {
    const header = buildTrojanRequestHeader(sha224HexOfPassword, target443);
    // CMD=0x01 (CONNECT), ATYP=0x03 (domain), dom_len=14, dom='api.openai.com', port=0x01bb.
    let off = 58;
    expect(header[off++]).toBe(0x01);
    expect(header[off++]).toBe(0x03);
    expect(header[off++]).toBe('api.openai.com'.length);
    const dom = new TextDecoder().decode(header.subarray(off, off + 14));
    expect(dom).toBe('api.openai.com');
    off += 14;
    expect(header[off++]).toBe(0x01);
    expect(header[off++]).toBe(0xbb);
    // Trailing CRLF.
    expect(header[off++]).toBe(0x0d);
    expect(header[off++]).toBe(0x0a);
    expect(header.byteLength).toBe(off);
  });

  it('rejects hostnames longer than 255 bytes', () => {
    const long: DialTarget = { host: 'a'.repeat(256), port: 443 };
    expect(() => buildTrojanRequestHeader('p', long)).toThrow(/too long/);
  });

  it('produces a stable byte sequence for a known password+target vector', () => {
    const header = buildTrojanRequestHeader('hello', { host: 'example.com', port: 80 });
    // hex(SHA-224("hello")) = "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193"
    const HASH = 'ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193';
    const wantPrefix = new TextEncoder().encode(HASH);
    expect(Array.from(header.subarray(0, 56))).toEqual(Array.from(wantPrefix));
    // CRLF | 0x01 | 0x03 | 0x0b | "example.com" | 0x00 0x50 | CRLF
    const tail = [
      0x0d, 0x0a,
      0x01, 0x03, 0x0b,
      ...new TextEncoder().encode('example.com'),
      0x00, 0x50,
      0x0d, 0x0a,
    ];
    expect(Array.from(header.subarray(56))).toEqual(tail);
  });
});
