// Single seam between gateway code and the per-protocol runners. Adding a
// new protocol = add a variant to ProxyConfig, a parser branch in url.ts,
// and a case here.

import { DEFAULT_DIAL_DEADLINE_MS } from './constants.js';
import { ProxyDialError } from './errors.js';
import { runHttpConnect } from './protocols/http-connect.js';
import { runReality } from './protocols/reality.js';
import { runShadowsocks2022 } from './protocols/shadowsocks-2022.js';
import { runShadowsocks } from './protocols/shadowsocks.js';
import { runSocks5 } from './protocols/socks5.js';
import { runTrojan } from './protocols/trojan.js';
import { runVlessTcpTls, runVlessWsTls } from './protocols/vless.js';
import type { ProxyConfig } from './proxy-config.js';
import type { TargetSpec } from './types.js';

export { DEFAULT_DIAL_DEADLINE_MS };

export interface RunProxiedRequestOptions {
  /** Per-call dial-stage deadline override (ms). Falls back to
   *  DEFAULT_DIAL_DEADLINE_MS when absent. */
  dialTimeoutMs?: number;
  /** Caller-supplied cancellation. Aborting tears down any in-flight
   *  socket and rejects the runProxiedRequest promise immediately. */
  signal?: AbortSignal;
}

export const runProxiedRequest = async (
  config: ProxyConfig,
  target: TargetSpec,
  options?: RunProxiedRequestOptions,
): Promise<Response> => {
  const deadlineMs = options?.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const callerSignal = options?.signal;
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
  try {
    return await dispatch(config, target, internal.signal);
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

const dispatch = async (config: ProxyConfig, target: TargetSpec, signal: AbortSignal): Promise<Response> => {
  switch (config.kind) {
  case 'http':
    return await runHttpConnect({
      proxyHost: config.host,
      proxyPort: config.port,
      proxyTls: config.tls,
      auth: config.username !== undefined
        ? { username: config.username, password: config.password ?? '' }
        : undefined,
      target,
      signal,
    });
  case 'socks5':
    return await runSocks5({
      proxyHost: config.host,
      proxyPort: config.port,
      auth: config.username !== undefined
        ? { username: config.username, password: config.password ?? '' }
        : undefined,
      target,
      signal,
    });
  case 'ss':
    return await runShadowsocks({
      serverHost: config.host,
      serverPort: config.port,
      method: config.method,
      password: config.password,
      target,
      signal,
    });
  case 'ss2022':
    return await runShadowsocks2022({
      serverHost: config.host,
      serverPort: config.port,
      method: config.method,
      password: config.passwordBase64,
      target,
      signal,
    });
  case 'trojan':
    return await runTrojan({
      serverHost: config.host,
      serverPort: config.port,
      password: config.password,
      target,
      signal,
    });
  case 'vless-tcp':
    return await runVlessTcpTls({
      serverHost: config.host,
      serverPort: config.port,
      uuid: config.uuid,
      target,
      signal,
    });
  case 'vless-ws':
    return await runVlessWsTls({
      serverHost: config.host,
      serverPort: config.port,
      uuid: config.uuid,
      path: config.path,
      target,
      signal,
    });
  case 'reality':
    return await runReality({
      serverHost: config.host,
      serverPort: config.port,
      publicKeyB64Url: config.publicKey,
      shortIdHex: config.shortId,
      spoofSni: config.serverName,
      uuid: config.uuid,
      target,
      signal,
    });
  default: {
    const _: never = config;
    throw new Error(`unknown ProxyConfig kind: ${(config as { kind: string }).kind}`);
  }
  }
};
