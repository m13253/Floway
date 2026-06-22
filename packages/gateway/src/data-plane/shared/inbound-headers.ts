import type { Context } from 'hono';

// Headers stripped from the inbound request before the data plane threads
// the bag down to the provider boundary. Three groups, one deny-list:
//
// - Gateway-owned auth + identity. Providers pin their own credentials and
//   content-type on the wire (Azure's `api-key`, Anthropic's `x-api-key`,
//   `Authorization: Bearer`, each provider's body-derived `content-type`,
//   the runtime's freshly-derived multipart boundary for FormData
//   passthrough). Letting any of these survive would clobber a pinned
//   value or leak a private one.
//
// - HTTP/1.1 framing + hop-by-hop (RFC 9110 §7.6.1). `content-length` and
//   `transfer-encoding` describe the inbound body and would mis-frame the
//   re-serialized outbound body — on Node this surfaces as undici's
//   `RequestContentLengthMismatchError`; Workers' `fetch` silently rewrites
//   the framing. `connection`, `keep-alive`, `proxy-connection`, `te`,
//   `trailer`, `upgrade`, `expect` are end-to-end meaningless; the runtime
//   fetch refuses most of them outright.
//
// - `accept-encoding`. End-to-end in spec terms, transport-level in
//   practice: the runtime fetch advertises the encodings it can
//   transparently decode, and SSE upstreams must stay uncompressed
//   end-to-end so stream parsers see raw bytes.
//
// Non-secret propagation signals (`forwarded`, `cf-*`, `x-real-ip`,
// `user-agent`, vendor `anthropic-*` / `openai-*` betas, and any other
// business header the client sends) stay in the bag and reach the
// upstream. Copilot and Codex clone the bag before merging their own
// pinned headers, so they inherit the scrub for free.
const SCRUBBED_INBOUND_HEADERS = [
  'accept-encoding',
  'api-key',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-floway-session',
  'x-goog-api-key',
];

// Build the unified inbound-headers bag the data plane threads to the
// provider boundary. Copies the source request's headers and removes the
// scrub set before the provider can observe them, regardless of whether
// the provider passes the bag through (Azure, custom, Ollama) or clones
// it into a boundary ctx (Copilot, Codex).
export const inboundHeadersForUpstream = (c: Context): Headers => {
  const headers = new Headers(c.req.raw.headers);
  for (const name of SCRUBBED_INBOUND_HEADERS) headers.delete(name);
  return headers;
};
