// @floway-dev/proxy — proxy URI parsing + per-protocol byte-stream dialers
// + a fetch-shaped orchestrator.
//
// The dial layer is transport-only: `dial(config, target, options)` returns
// a duplex byte stream that lands at `target.host:target.port`. Inner TLS
// to the upstream and HTTP/1.1 framing live in @floway-dev/http; the
// orchestrator `runProxiedRequest` composes the three for callers that
// just want a Response.
//
// Most dialers stay runtime-agnostic by taking the raw TCP `socketDial`
// primitive through DialOptions, so the same library runs on Workers
// (`cloudflare:sockets`), Node (`node:net`), or any future target that
// supplies a SocketDial impl. The one exception is `vless-ws`, which goes
// through the runtime's global `fetch()` to perform the WebSocket upgrade —
// only workerd's fetch returns a `webSocket` handle on the Response, so
// that variant is workerd-only by construction.

export type { DialTarget, ProxyRequestTarget, DialOptions, DialResult, SocketDial, SocketDialOptions, DialedSocket } from './types.ts';

export { formatProxyUri, parseProxyUri } from './url.ts';
export { kindFromUri } from './url-kind.ts';

export type {
  ProxyConfig,
  HttpProxyConfig,
  Socks5ProxyConfig,
  ShadowsocksProxyConfig,
  Shadowsocks2022ProxyConfig,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
  RealityProxyConfig,
  SsMethod,
  Ss2022Method,
} from './proxy-config.ts';

export { ProxyDialError, ProxyUriError } from './errors.ts';

export { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';
export { dial, runProxiedRequest } from './dialer.ts';
export type { RunProxiedRequestOptions } from './dialer.ts';
