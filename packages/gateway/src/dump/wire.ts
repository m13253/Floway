import type {
  DumpBody,
  DumpRecord,
  DumpRequest,
  DumpResponse,
  DumpResponseBody,
  StoredDumpRecord,
  StoredDumpRequest,
  StoredDumpResponse,
  StoredDumpResponseBody,
} from './types.ts';

const TEXT_LIKE_PREFIXES = ['text/', 'application/json', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded'];

const looksTextual = (contentType: string): boolean => {
  const base = contentType.toLowerCase().split(';')[0]!.trim();
  return TEXT_LIKE_PREFIXES.some(prefix => base.startsWith(prefix));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
};

const contentTypeOf = (headers: ReadonlyArray<[string, string]>): string =>
  headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';

// Wire encoding decision: textual content-types try UTF-8 first and fall
// back to base64 when the bytes do not decode cleanly (a content-type that
// lied about being text). Binary content-types skip the probe.
const encodeBodyForWire = (bytes: Uint8Array, contentType: string): DumpBody => {
  if (looksTextual(contentType)) {
    try {
      return { encoding: 'utf8', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      // fall through
    }
  }
  return { encoding: 'base64', data: bytesToBase64(bytes) };
};

const requestToWire = (req: StoredDumpRequest): DumpRequest => ({
  method: req.method,
  path: req.path,
  headers: req.headers,
  body: encodeBodyForWire(req.body, contentTypeOf(req.headers)),
});

const responseBodyToWire = (body: StoredDumpResponseBody, responseHeaders: ReadonlyArray<[string, string]>): DumpResponseBody => {
  switch (body.type) {
  case 'stream': return { type: 'stream', events: body.events };
  case 'bytes':  return { type: 'bytes', body: encodeBodyForWire(body.body, contentTypeOf(responseHeaders)) };
  case 'none':   return { type: 'none' };
  }
};

const responseToWire = (res: StoredDumpResponse): DumpResponse => ({
  status: res.status,
  headers: res.headers,
  body: responseBodyToWire(res.body, res.headers),
});

// Sole place the storage shape crosses into the wire shape. Called once,
// at the control-plane HTTP boundary, just before `c.json(...)`.
export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => ({
  meta: record.meta,
  request: requestToWire(record.request),
  response: responseToWire(record.response),
});
