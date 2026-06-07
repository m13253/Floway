// @floway-dev/proxy — outbound proxy-dialing library.
//
// Each `runXxx(opts)` function dials through the named proxy protocol and
// issues an HTTP/1.1 request against the upstream described by `opts.target`.
// Returns a Web `Response` whose body is a `ReadableStream<Uint8Array>` of the
// upstream's response body (decrypted, transfer-encoding decoded).
//
// All variants use a single hand-rolled HTTP/1.1 client over a userspace
// TLS implementation built on `@reclaimprotocol/tls` (see `tls.ts`). TCP
// dialing goes through `getSocketDial()` from `@floway-dev/platform`, so the
// host runtime — Cloudflare Workers (`cloudflare:sockets`), Node (`node:net`),
// or any future target — only needs to ship a `SocketDial` impl at boot.

export type { TargetSpec } from './types.js';

export { formatProxyUri, parseProxyUri } from './url.js';

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
} from './proxy-config.js';

export { ProxyDialError } from './errors.js';

export { runProxiedRequest, DEFAULT_DIAL_DEADLINE_MS } from './dialer.js';
export type { RunProxiedRequestOptions } from './dialer.js';

export { runHttpConnect } from './protocols/http-connect.js';
export type { HttpConnectOptions } from './protocols/http-connect.js';

export { runSocks5 } from './protocols/socks5.js';
export type { Socks5Options } from './protocols/socks5.js';

export { runTrojan } from './protocols/trojan.js';
export type { TrojanOptions } from './protocols/trojan.js';

export { runVlessTcpTls, runVlessWsTls } from './protocols/vless.js';
export type { VlessTcpTlsOptions, VlessWsTlsOptions } from './protocols/vless.js';

export { runShadowsocks } from './protocols/shadowsocks.js';
export type { ShadowsocksOptions } from './protocols/shadowsocks.js';

export { runShadowsocks2022 } from './protocols/shadowsocks-2022.js';
export type { Shadowsocks2022Options } from './protocols/shadowsocks-2022.js';

export { runReality } from './protocols/reality.js';
export type { RealityOptions } from './protocols/reality.js';

// Lower-level building blocks exposed for advanced composition.
export { userspaceTls } from './tls.js';
export type { UserspaceTlsOptions, TlsStream } from './tls.js';

export { runHttp1 } from './http1.js';
export type { DuplexBytes } from './http1.js';
