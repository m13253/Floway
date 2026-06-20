import type { DumpBody } from '@floway-dev/protocols/dump';

// Wire format helpers shared between the dump capture middleware and the
// persisted-row rehydrator. `DumpBody` discriminates the encoding directly,
// so the original captured content-type header stays untouched on its
// `headers` pair — operators see exactly what the upstream sent.

const TEXT_LIKE_PREFIXES = ['text/', 'application/json', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded'];

export const looksTextual = (contentType: string): boolean => {
  const base = contentType.toLowerCase().split(';')[0]!.trim();
  return TEXT_LIKE_PREFIXES.some(prefix => base.startsWith(prefix));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// UTF-8 text when the content-type claims textual AND the bytes actually
// decode under strict UTF-8; base64 otherwise. A textual content-type with
// non-UTF-8 bytes (upstream misreporting) falls through to base64 rather
// than producing mojibake.
export const encodeBodyForWire = (bytes: Uint8Array, contentType: string): DumpBody => {
  if (looksTextual(contentType)) {
    try {
      return { encoding: 'utf8', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      // Content-type lied about being text; fall through to base64.
    }
  }
  return { encoding: 'base64', data: bytesToBase64(bytes) };
};

export const decodeBodyFromWire = (body: DumpBody): Uint8Array => {
  if (body.encoding === 'utf8') return new TextEncoder().encode(body.data);
  return base64ToBytes(body.data);
};
