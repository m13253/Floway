// Single seam between gateway code and the per-protocol runners. Adding a
// new protocol = add a variant to ProxyConfig, a parser branch in url.ts,
// and a case here.

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

// Hard ceiling on the time the dial layer is allowed to spend before the
// fallback chain moves on. Counts TCP connect + every handshake leg, but
// not the upstream response — once the request bytes have been written we
// expect normal response streaming. Reality / VLESS-WS / Trojan over a
// real-world latency-bound link can take 8-15s for outer-TCP + outer-TLS
// + proxy-handshake + inner-TLS combined; 30s leaves ~2× headroom on top
// of that without letting a black-holed proxy entry stall the call for a
// minute+.
const DIAL_DEADLINE_MS = 30_000;

export const runProxiedRequest = async (
  config: ProxyConfig,
  target: TargetSpec,
): Promise<Response> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProxyDialError(`dial deadline exceeded after ${DIAL_DEADLINE_MS}ms`, 'tcp-connect')),
      DIAL_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([dispatch(config, target), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const dispatch = async (config: ProxyConfig, target: TargetSpec): Promise<Response> => {
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
    });
  case 'socks5':
    return await runSocks5({
      proxyHost: config.host,
      proxyPort: config.port,
      auth: config.username !== undefined
        ? { username: config.username, password: config.password ?? '' }
        : undefined,
      target,
    });
  case 'ss':
    return await runShadowsocks({
      serverHost: config.host,
      serverPort: config.port,
      method: config.method,
      password: config.password,
      target,
    });
  case 'ss2022':
    return await runShadowsocks2022({
      serverHost: config.host,
      serverPort: config.port,
      method: config.method,
      password: config.passwordBase64,
      target,
    });
  case 'trojan':
    return await runTrojan({
      serverHost: config.host,
      serverPort: config.port,
      password: config.password,
      target,
    });
  case 'vless-tcp':
    return await runVlessTcpTls({
      serverHost: config.host,
      serverPort: config.port,
      uuid: config.uuid,
      target,
    });
  case 'vless-ws':
    return await runVlessWsTls({
      serverHost: config.host,
      serverPort: config.port,
      uuid: config.uuid,
      path: config.path,
      target,
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
    });
  default: {
    const _: never = config;
    throw new Error(`unknown ProxyConfig kind: ${(config as { kind: string }).kind}`);
  }
  }
};
