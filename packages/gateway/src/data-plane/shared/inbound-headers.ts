import type { Context } from 'hono';

// Headers that authenticate the client to the gateway, plus per-hop
// headers the inbound request sets for the gateway-side connection.
// Inbound copies of any gateway-pinned auth header would override the
// pinned value and either leak a gateway-private credential or hand the
// upstream a value the client controls. `content-type` is stripped for
// the same reason: each provider sets it from the wire-body shape it
// builds, and a FormData passthrough additionally needs the runtime to
// derive a fresh multipart boundary on the outbound request.
//
// `content-length`, `content-encoding`, and `transfer-encoding` describe
// the inbound body's wire shape, not the outbound body the provider
// rebuilds; forwarding `content-length` over a re-serialised body causes
// the runtime to ship only the leaked-length prefix and the upstream to
// hang on the missing tail until it resets the connection. Drop these
// so the outbound fetch derives them from the actual body it sees.
const GATEWAY_PRIVATE_INBOUND_HEADERS = [
  'api-key',
  'authorization',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'x-api-key',
  'x-floway-session',
  'x-goog-api-key',
];

// Build the unified inbound-headers bag the data plane threads to the
// provider boundary. Copies the source request's headers and removes the
// gateway's own auth + per-hop signals before the provider can observe
// them, regardless of whether the provider passes the bag through (Azure,
// custom) or clones it into a boundary ctx (Copilot, Codex).
export const inboundHeadersForUpstream = (c: Context): Headers => {
  const headers = new Headers(c.req.raw.headers);
  for (const name of GATEWAY_PRIVATE_INBOUND_HEADERS) headers.delete(name);
  return headers;
};
