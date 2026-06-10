// @floway-dev/proxy — proxy URI parsing, per-protocol byte-stream dialers,
// and a `runProxiedRequest` orchestrator that composes dial → optional
// userspace TLS → fetch-on-stream.
//
// `dial(config, target, options)` returns a duplex byte stream landing at
// `target.host:target.port`; inner TLS and HTTP/1.1 framing live in
// @floway-dev/http. Dialers stay runtime-agnostic by taking the raw TCP
// `socketDial` primitive through DialOptions.

export type { ProxyRequestTarget, SocketDial } from './types.ts';

export { parseProxyUri } from './url.ts';

export type { ProxyConfig } from './proxy-config.ts';

export { ProxyDialError, ProxyUriError } from './errors.ts';

export { runProxiedRequest } from './dialer.ts';
export type { RunProxiedRequestOptions } from './dialer.ts';
