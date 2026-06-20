// Wire-level shapes for the per-API-key request dump feature. Lives in
// `@floway-dev/protocols` so the gateway core, both platform impls, and the
// dashboard SPA all import the same definitions.
//
// The dashboard receives a fully-rehydrated `DumpRecord` from the control
// plane — bodies are inlined as UTF-8 text (or base64 for non-text bytes
// with `;base64` appended to the captured content-type). On the storage
// side, bodies live as separate gzipped files referenced by descriptors
// in D1; the rehydration happens in `DumpStore.get`.

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

export interface DumpRequest {
  method: string;
  path: string;
  // Order-preserving header pairs. We do not redact: every header is
  // captured verbatim because the API key is already in our database and
  // the dump only surfaces to the key's own operator.
  headers: Array<[string, string]>;
  // UTF-8 text; or base64 with `;base64` suffix on the recorded
  // content-type when the body was non-textual at capture time.
  body: string;
}

export type DumpResponseBody =
  | { type: 'stream'; events: DumpStreamEvent[] }
  | { type: 'bytes'; body: string }
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
