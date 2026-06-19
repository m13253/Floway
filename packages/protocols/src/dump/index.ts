// Data contract between the gateway core, both platform implementations,
// and the dashboard SPA for the per-request dump feature. Lives in
// `@floway-dev/protocols` so the gateway can depend on the shapes without
// pulling collect-function code into the Worker bundle.

export type DumpRecordId = string;  // ULID

export interface DumpUpstreamRef {
  id: string;
  name: string;
  // Free-form provider kind string. The dashboard colors by this; unknown
  // kinds get a neutral tone.
  kind: string;
}

export interface DumpMetadata {
  id: DumpRecordId;
  startedAt: number;        // Unix ms.
  completedAt: number;      // Unix ms.
  method: string;
  path: string;             // includes query string.
  status: number;           // 0 when no response status was produced.
  upstream: DumpUpstreamRef | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Captured wire-level byte counts; rendered as upload/download indicators
  // in the request list.
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  error: string | null;     // single-line summary; null on clean responses.
}

export interface DumpStreamEvent {
  // SSE "event:" line, or null for an SSE frame with only a "data:" line.
  event: string | null;
  data: string;
  ts: number;               // ms relative to startedAt.
}

export type DumpResponseBody =
  | { type: 'stream'; events: DumpStreamEvent[] }
  | { type: 'bytes'; body: string }   // base64 when content is non-textual.
  | { type: 'none' };                  // no response bytes produced at all.

export interface DumpRequest {
  method: string;
  path: string;
  // Array of pairs preserves header order and multi-value (e.g. multiple
  // set-cookie). We do not redact: every header is captured verbatim because
  // the API key is already in our database; the dump exposes no secret the
  // operator does not already control.
  headers: Array<[string, string]>;
  // utf-8 text; base64 with ';base64' suffix on the recorded content-type
  // when non-textual.
  body: string;
}

export type DumpRecord = {
  meta: DumpMetadata;
  request: DumpRequest;
  response: { status: number; headers: Array<[string, string]> } & DumpResponseBody;
};
