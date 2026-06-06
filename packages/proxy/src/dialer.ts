// Single seam between gateway code and the per-protocol runners. Adding a
// new protocol = add a variant to ProxyConfig, a parser branch in url.ts,
// and a case here.

import { runHttpConnect } from './protocols/http-connect.js';
import { runReality } from './protocols/reality.js';
import { runShadowsocks2022 } from './protocols/shadowsocks-2022.js';
import { runShadowsocks } from './protocols/shadowsocks.js';
import { runSocks5 } from './protocols/socks5.js';
import { runTrojan } from './protocols/trojan.js';
import { runVlessTcpTls, runVlessWsTls } from './protocols/vless.js';
import type { ProxyConfig } from './proxy-config.js';
import type { TargetSpec } from './types.js';

export const runProxiedRequest = async (
  config: ProxyConfig,
  target: TargetSpec,
): Promise<Response> => {
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
      shortIdHex: config.shortId ?? '0000000000000000',
      spoofSni: config.serverName,
      uuid: config.uuid,
      target,
    });
  }
};
