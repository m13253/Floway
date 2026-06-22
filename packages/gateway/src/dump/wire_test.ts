import { test } from 'vitest';

import { decodeBodyFromWire, encodeBodyForWire } from './wire.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Probe `looksTextual` (a private detail of `encodeBodyForWire`) through the
// public encode helper: a textual content-type with valid UTF-8 bytes encodes
// as utf8, a binary content-type or non-UTF-8 bytes falls through to base64.
const utf8 = new TextEncoder().encode('x');

test('encodeBodyForWire treats common textual content-types as utf8', () => {
  for (const ct of [
    'text/plain',
    'text/html; charset=utf-8',
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    'application/xml',
    'application/x-www-form-urlencoded',
    'text/plain;something',
  ]) {
    assertEquals(encodeBodyForWire(utf8, ct).encoding, 'utf8');
  }
});

test('encodeBodyForWire treats binary content-types and empty content-type as base64', () => {
  for (const ct of ['image/png', 'application/octet-stream', 'image/jpeg', 'application/pdf', '', 'image/png;base64']) {
    assertEquals(encodeBodyForWire(utf8, ct).encoding, 'base64');
  }
});

test('encodeBodyForWire/decodeBodyFromWire round-trip UTF-8 text', () => {
  const bytes = new TextEncoder().encode('hello — world');
  const wire = encodeBodyForWire(bytes, 'text/plain');
  assertEquals(wire.encoding, 'utf8');
  assertEquals(wire.data, 'hello — world');
  const back = decodeBodyFromWire(wire);
  assertEquals(new TextDecoder().decode(back), 'hello — world');
});

test('encodeBodyForWire falls back to base64 when textual content-type carries non-UTF-8 bytes', () => {
  // 0xFF is invalid UTF-8 alone.
  const bytes = new Uint8Array([0xFF, 0xFE, 0xFD]);
  const wire = encodeBodyForWire(bytes, 'text/plain');
  assertEquals(wire.encoding, 'base64');
  const back = decodeBodyFromWire(wire);
  assertEquals(Array.from(back), [0xFF, 0xFE, 0xFD]);
});

test('encodeBodyForWire base64-encodes binary content-types', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG magic
  const wire = encodeBodyForWire(bytes, 'image/png');
  assertEquals(wire.encoding, 'base64');
  const back = decodeBodyFromWire(wire);
  assertEquals(Array.from(back), [0x89, 0x50, 0x4E, 0x47]);
});
