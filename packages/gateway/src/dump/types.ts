// Wire-level shapes for the per-API-key request dump feature, shared by
// the gateway, platform impls, and the dashboard SPA.

import type { ProtocolFrame } from '@floway-dev/protocols/common';

export type DumpRecordId = string;

export interface DumpUpstreamRef {
  id: string;
  name: string;
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
  // Raw (pre-gzip) byte counts of the captured bodies.
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  error: string | null;     // single-line summary
}

// Canonical protocol frame the gateway's respond layer fans out to every
// dump-enabled key. Stored as ProtocolFrame (not the SSE-serialized form)
// so the gateway's live fold and the dashboard's cold fold can share the
// same `collectXProtocolEventsToResult` reducer; the SSE wire view is
// derived on demand by the dashboard via `XProtocolFrameToSSEFrame`.
//
// `unknown` for the event payload because the storage layer is protocol-
// agnostic — the dashboard dispatches the right per-protocol serializer
// based on `meta.path`.
export interface DumpStreamEvent {
  frame: ProtocolFrame<unknown>;
  ts: number;               // ms relative to startedAt
}

// `utf8` is chosen from the upstream content-type, with a UTF-8-fatal
// fallback to `base64` when a textual content-type carried non-UTF-8 bytes.
export type DumpBody =
  | { encoding: 'utf8'; data: string }
  | { encoding: 'base64'; data: string };

export interface DumpRequest {
  method: string;
  path: string;
  // Captured verbatim with no redaction: the dump only surfaces to the
  // owning API key's operator, who already holds the key.
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
