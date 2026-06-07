// @floway-dev/proxy — proxy URI parsing + per-protocol byte-stream dialers
// + a fetch-shaped orchestrator.
//
// The dial layer is transport-only: `dial(config, target, options)` returns
// a duplex byte stream that lands at `target.host:target.port`. Inner TLS
// to the upstream and HTTP/1.1 framing live in @floway-dev/http; the
// orchestrator `runProxiedRequest` composes the three for callers that
// just want a Response.
//
// The proxy package does NOT depend on any specific runtime — every dialer
// takes `socketDial` through DialOptions, so the same library runs on
// Workers (`cloudflare:sockets`), Node (`node:net`), or any future target
// that supplies a SocketDial impl.

export type { DialTarget, ProxyRequestTarget, DialOptions, DialResult, SocketDial, SocketDialOptions, DialedSocket } from './types.ts';

export { formatProxyUri, parseProxyUri } from './url.ts';
export { kindFromUri } from './url-kind.ts';

export type {
  ProxyConfig,
  ProxyConfigBase,
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

export { ProxyDialError } from './errors.ts';

export { dial, runProxiedRequest, DEFAULT_DIAL_DEADLINE_MS } from './dialer.ts';
export type { RunProxiedRequestOptions } from './dialer.ts';
