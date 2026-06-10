// VLESS dialer composition: two transport variants for the VLESS protocol —
// TCP+TLS and WebSocket+TLS — each going through `socketDial(tls=true)`
// to the proxy and delegating header construction + reply-prefix framing
// to `vlessFrameOverStream` in vless-core.ts. The WS variant inserts
// `wsUpgradeAndFrame` from @floway-dev/http between the outer TLS and the
// VLESS framing so it stays runtime-agnostic.

import type { VlessTcpTlsProxyConfig, VlessWsTlsProxyConfig } from '../proxy-config.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../types.ts';
import type { DialOptions, DialResult, DialTarget } from '../types.ts';
import { vlessFrameOverStream } from './vless-core.ts';
import { wsUpgradeAndFrame } from '@floway-dev/http';

export const dialVlessTcpTls = async (
  config: VlessTcpTlsProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS', { maxBytes: 255 });
  // workerd handles outer TLS to the VLESS server inside connect(tls=true);
  // we can't distinguish a TCP RST from a TLS handshake failure here, so any
  // dial-time error is reported as tcp-connect.
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { tls: true, signal: options.signal });

  try {
    return await vlessFrameOverStream(socket, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

export const dialVlessWsTls = async (
  config: VlessWsTlsProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS', { maxBytes: 255 });
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { tls: true, signal: options.signal });

  try {
    const wsStream = await wsUpgradeAndFrame(socket, {
      host: config.wsHost ?? config.host,
      path: config.path,
      signal: options.signal,
    });
    return await vlessFrameOverStream(wsStream, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};
