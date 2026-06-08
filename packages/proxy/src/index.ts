// @floway-dev/proxy — proxy URI parsing, per-protocol byte-stream dialers,
// and a `runProxiedRequest` orchestrator that composes dial → optional
// userspace TLS → fetch-on-stream into a real Response.
//
// `dial(config, target, options)` returns a duplex byte stream landing at
// `target.host:target.port`; inner TLS and HTTP/1.1 framing live in
// @floway-dev/http. Dialers stay runtime-agnostic by taking the raw TCP
// `socketDial` primitive through DialOptions, so the same code runs on
// Workers (`cloudflare:sockets`), Node (`node:net`), or any other target.
// The one exception is `vless-ws`, which is workerd-only because only
// workerd's fetch returns a `webSocket` handle on the upgrade Response.

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
export { SS_METHODS, SS2022_METHODS } from './proxy-config.ts';

export { ProxyDialError, ProxyUriError } from './errors.ts';

export { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';
export { dial, runProxiedRequest } from './dialer.ts';
export type { RunProxiedRequestOptions } from './dialer.ts';
