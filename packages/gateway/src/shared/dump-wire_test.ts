import { test } from 'vitest';

import { decodeBodyFromWire, encodeBodyForWire, looksTextual } from './dump-wire.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('looksTextual recognises common textual content-types', () => {
  assertEquals(looksTextual('text/plain'), true);
  assertEquals(looksTextual('text/html; charset=utf-8'), true);
  assertEquals(looksTextual('application/json'), true);
  assertEquals(looksTextual('application/json; charset=utf-8'), true);
  assertEquals(looksTextual('APPLICATION/JSON'), true);
  assertEquals(looksTextual('application/xml'), true);
  assertEquals(looksTextual('application/x-www-form-urlencoded'), true);
});

test('looksTextual rejects binary content-types', () => {
  assertEquals(looksTextual('image/png'), false);
  assertEquals(looksTextual('application/octet-stream'), false);
  assertEquals(looksTextual('image/jpeg'), false);
  assertEquals(looksTextual('application/pdf'), false);
  assertEquals(looksTextual(''), false);
});

test('looksTextual strips content-type parameters before matching', () => {
  // The base type wins; trailing parameters (charset, boundary, base64, …) are
  // ignored. The earlier per-file copies in capture-dump and dump-store
  // disagreed on this, so the test pins the unified behavior.
  assertEquals(looksTextual('text/plain;something'), true);
  assertEquals(looksTextual('image/png;base64'), false);
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
