import type { ImageDimensions } from './types.ts';

// Reads pixel dimensions straight from the image header bytes. We parse
// locally instead of calling the Cloudflare Images `info()` binding because
// every binding call — `info()` included — is billed as a transformation and
// binding responses are not deduplicated, so a metadata lookup would double
// the per-image cost. Returns null for formats we do not recognise; callers
// fall back to re-encoding without a resize in that case.
//
// Header layout references:
// - PNG: https://www.w3.org/TR/png/#11IHDR
// - GIF: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
// - JPEG SOF markers: https://www.w3.org/Graphics/JPEG/itu-t81.pdf
// - WebP (VP8/VP8L/VP8X): https://developers.google.com/speed/webp/docs/riff_container

const isPng = (b: Uint8Array): boolean => b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const isGif = (b: Uint8Array): boolean => b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;

const isJpeg = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;

const isWebp = (b: Uint8Array): boolean =>
  b.length >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

const readPng = (view: DataView): ImageDimensions => ({ width: view.getUint32(16), height: view.getUint32(20) });

const readGif = (view: DataView): ImageDimensions => ({ width: view.getUint16(6, true), height: view.getUint16(8, true) });

const readJpeg = (b: Uint8Array, view: DataView): ImageDimensions | null => {
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1];
    // SOF0..SOF15 carry the frame dimensions; DHT/DAC/RST/SOS markers do not.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
};

const readWebp = (b: Uint8Array, view: DataView): ImageDimensions | null => {
  const format = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (format === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    const width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width, height };
  }
  return null;
};

export const readImageDimensions = (bytes: Uint8Array): ImageDimensions | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) return readPng(view);
  if (isGif(bytes)) return readGif(view);
  if (isJpeg(bytes)) return readJpeg(bytes, view);
  if (isWebp(bytes)) return readWebp(bytes, view);
  return null;
};
