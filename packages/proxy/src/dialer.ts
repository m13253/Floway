// The dial dispatcher and the proxied-fetch orchestrator.
//
// `dial` opens a duplex byte stream to `target.host:target.port` through
// the proxy described by `config`. It returns a transport-only stream —
// inner-TLS to the upstream and HTTP/1.1 framing live above this layer.
//
// `runProxiedRequest` composes `dial` → optional `userspaceTls` → `fetchOnStream`
// to produce a real HTTP `Response` for callers that don't want to manage
// the duplex themselves.
//
// Adding a new protocol = add a variant to ProxyConfig, a parser branch
// in url.ts, and a case in `dial` here.

import { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';
import { ProxyDialError } from './errors.ts';
import { dialHttpConnect } from './protocols/http-connect.ts';
import { dialReality } from './protocols/reality.ts';
import { dialShadowsocks2022 } from './protocols/shadowsocks-2022.ts';
import { dialShadowsocks } from './protocols/shadowsocks.ts';
import { dialSocks5 } from './protocols/socks5.ts';
import { dialTrojan } from './protocols/trojan.ts';
import { dialVlessTcpTls, dialVlessWsTls } from './protocols/vless.ts';
import type { ProxyConfig } from './proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, ProxyRequestTarget } from './types.ts';
import { resolveSni, resolveVerifyHost } from './types.ts';
import { fetchOnStream, userspaceTls, type DuplexStream, type HttpRequest, type TlsStream } from '@floway-dev/http';

export { DEFAULT_DIAL_DEADLINE_MS };

/**
 * Open a transport-only duplex byte stream to `target.host:target.port`
 * through the named proxy. The returned stream is plain bytes — no inner
 * TLS to the upstream and no HTTP/1.1 framing — so the caller is free to
 * layer those (or anything else) on top.
 *
 * `result.prefix`, when present, is bytes the protocol wants prepended to
 * the very first record the caller emits next (see DialResult.prefix).
 */
export const dial = async (
  config: ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  const deadlineMs = options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    throw new DOMException(String(callerSignal.reason ?? 'aborted'), 'AbortError');
  }
  // We multiplex the caller signal and our deadline into a single internal
  // AbortController. Setting the abort `reason` to a ProxyDialError on
  // deadline lets us surface the deadline as a typed error after dispatch
  // unwinds — even if the underlying runner returned a different exception
  // because abort propagation was racy.
  const internal = new AbortController();
  const onCallerAbort = (): void => {
    internal.abort(callerSignal!.reason ?? new DOMException('aborted', 'AbortError'));
  };
  if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(
    () => internal.abort(new ProxyDialError(`dial deadline exceeded after ${deadlineMs}ms`, 'tcp-connect')),
    deadlineMs,
  );
  const innerOptions: DialOptions = {
    ...options,
    signal: internal.signal,
  };
  try {
    return await dispatchDial(config, target, innerOptions);
  } catch (err) {
    if (internal.signal.aborted && internal.signal.reason instanceof ProxyDialError) {
      throw internal.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
};

const dispatchDial = async (config: ProxyConfig, target: DialTarget, options: DialOptions): Promise<DialResult> => {
  switch (config.kind) {
  case 'http':
    return await dialHttpConnect(config, target, options);
  case 'socks5':
    return await dialSocks5(config, target, options);
  case 'ss':
    return await dialShadowsocks(config, target, options);
  case 'ss2022':
    return await dialShadowsocks2022(config, target, options);
  case 'trojan':
    return await dialTrojan(config, target, options);
  case 'vless-tcp':
    return await dialVlessTcpTls(config, target, options);
  case 'vless-ws':
    return await dialVlessWsTls(config, target, options);
  case 'reality':
    return await dialReality(config, target, options);
  default: {
    const _: never = config;
    throw new Error(`unknown ProxyConfig kind: ${(config as { kind: string }).kind}`);
  }
  }
};

export interface RunProxiedRequestOptions extends DialOptions {}

/**
 * Compose `dial` → optional `userspaceTls` → `fetchOnStream` into a single
 * call that returns a real HTTP `Response` whose body is the upstream's
 * response body (decrypted, transfer-encoding decoded).
 *
 * The dial-stage deadline applies to dial + outer-TLS + proxy-handshake
 * + inner-TLS combined; once the request bytes have been written the
 * upstream's response time is unbounded by this options surface.
 */
export const runProxiedRequest = async (
  config: ProxyConfig,
  target: ProxyRequestTarget,
  request: HttpRequest,
  options: RunProxiedRequestOptions,
): Promise<Response> => {
  const dialed = await dial(config, target, options);
  // Trojan plain-HTTP needs its 56-byte auth header to ride in the same
  // TLS record as the request line; Trojan TLS-upstream needs it as the
  // outer prefix to the inner-TLS ClientHello. Route the prefix to
  // whichever wrapper consumes the next bytes.
  let stream: DuplexStream = { readable: dialed.readable, writable: dialed.writable };
  let fetchPrefix: Uint8Array | undefined;
  if (target.tls) {
    let tls: TlsStream;
    try {
      tls = await userspaceTls(stream, {
        host: resolveSni(target),
        verifyHost: resolveVerifyHost(target),
        alpn: target.alpn,
        prefix: dialed.prefix,
        signal: options.signal,
      });
    } catch (cause) {
      // The dialer's framing pump can surface a typed ProxyDialError
      // (CONNECT 4xx, VLESS bad-version, SS auth fail, …) into the
      // userspace-TLS handshake as the underlying transport error.
      // Preserve the original stage rather than mis-tagging it as inner-tls.
      if (cause instanceof ProxyDialError) throw cause;
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    stream = tls;
  } else {
    fetchPrefix = dialed.prefix;
  }
  // Synthesize a Host header from the dial target if the caller didn't
  // provide one. The proxy package owns the host-vs-Host distinction —
  // @floway-dev/http stays transport-target-agnostic.
  const headers = ensureHostHeader(request.headers, target);
  return await fetchOnStream(stream, { ...request, headers }, { prefix: fetchPrefix });
};

const ensureHostHeader = (headers: Record<string, string>, target: ProxyRequestTarget): Record<string, string> => {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'host') return headers;
  }
  return { ...headers, Host: target.host };
};
