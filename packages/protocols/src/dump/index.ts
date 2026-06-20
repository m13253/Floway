// Wire-level shapes for the per-API-key request dump feature. Lives in
// `@floway-dev/protocols` so the gateway core, both platform impls, and the
// dashboard SPA all import the same definitions.
//
// The dashboard receives a fully-rehydrated `DumpRecord` from the control
// plane — bodies are inlined as a discriminated `DumpBody`. Storage-side,
// bodies live as separate gzipped files referenced by descriptors in D1;
// the rehydration happens in `DumpStore.get`.

export type DumpRecordId = string;

export interface DumpUpstreamRef {
  id: string;
  name: string;
  // Free-form provider kind string. The dashboard colors by this; unknown
  // kinds get a neutral tone. Persisted as `upstreams.provider` in the DB.
  kind: string;
}

export interface DumpMetadata {
  id: DumpRecordId;
  startedAt: number;        // unix ms
  completedAt: number;      // unix ms
  method: string;
  path: string;             // includes query string
  status: number;           // 0 when no response status was produced
  upstream: DumpUpstreamRef | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Wire-level byte counts of the captured bodies (gunzipped, raw).
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  error: string | null;     // single-line summary; null on clean responses
}

export interface DumpStreamEvent {
  // SSE "event:" line; null for a frame with only a "data:" line.
  event: string | null;
  data: string;
  ts: number;               // ms relative to startedAt
}

// Discriminated body payload. `utf8` carries text directly; `base64` carries
// raw bytes the dashboard must decode. The encoding is decided by the
// capture middleware from the upstream content-type, with a UTF-8-fatal
// fallback to base64 when a "textual" content-type carried non-UTF-8 bytes.
export type DumpBody =
  | { encoding: 'utf8'; data: string }
  | { encoding: 'base64'; data: string };

export interface DumpRequest {
  method: string;
  path: string;
  // Order-preserving header pairs. We do not redact: every header is
  // captured verbatim because the API key is already in our database and
  // the dump only surfaces to the key's own operator.
  headers: Array<[string, string]>;
  body: DumpBody;
}

export type DumpResponseBody =
  | { type: 'stream'; events: DumpStreamEvent[] }
  | { type: 'bytes'; body: DumpBody }
  | { type: 'none' };

export interface DumpResponse {
  status: number;
  headers: Array<[string, string]>;
}

export type DumpRecord = {
  meta: DumpMetadata;
  request: DumpRequest;
  response: DumpResponse & DumpResponseBody;
};
