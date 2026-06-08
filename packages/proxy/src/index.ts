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

export type { ProxyRequestTarget, SocketDial } from './types.ts';

export { parseProxyUri } from './url.ts';

export type { ProxyConfig } from './proxy-config.ts';

export { ProxyDialError } from './errors.ts';

export { runProxiedRequest } from './dialer.ts';
export type { RunProxiedRequestOptions } from './dialer.ts';
