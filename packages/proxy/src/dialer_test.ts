import { describe, expect, it, vi } from 'vitest';

import { runProxiedRequest } from './dialer.js';
import type { ProxyConfig } from './proxy-config.js';
import type { TargetSpec } from './types.js';

vi.mock('./protocols/http-connect.js', () => ({
  runHttpConnect: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/socks5.js', () => ({
  runSocks5: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/trojan.js', () => ({
  runTrojan: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/vless.js', () => ({
  runVlessTcpTls: vi.fn(async () => new Response('ok')),
  runVlessWsTls: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/shadowsocks.js', () => ({
  runShadowsocks: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/shadowsocks-2022.js', () => ({
  runShadowsocks2022: vi.fn(async () => new Response('ok')),
}));
vi.mock('./protocols/reality.js', () => ({
  runReality: vi.fn(async () => new Response('ok')),
}));

const target: TargetSpec = {
  dialHost: 'api.openai.com',
  port: 443,
  tls: true,
  method: 'GET',
  path: '/v1/models',
  headers: {},
};

const cases: Array<[ProxyConfig['kind'], ProxyConfig]> = [
  ['http', { kind: 'http', tls: false, host: 'h', port: 1, name: 'h' }],
  ['socks5', { kind: 'socks5', host: 'h', port: 1, name: 'h' }],
  ['trojan', { kind: 'trojan', password: 'p', host: 'h', port: 1, name: 'h' }],
  ['vless-tcp', { kind: 'vless-tcp', uuid: 'u', host: 'h', port: 1, name: 'h' }],
  ['vless-ws', { kind: 'vless-ws', uuid: 'u', host: 'h', port: 1, path: '/', name: 'h' }],
  ['ss', { kind: 'ss', method: 'aes-256-gcm', password: 'p', host: 'h', port: 1, name: 'h' }],
  ['ss2022', { kind: 'ss2022', method: '2022-blake3-aes-128-gcm', passwordBase64: 'a', host: 'h', port: 1, name: 'h' }],
  ['reality', { kind: 'reality', uuid: 'u', publicKey: 'p', fingerprint: 'chrome', serverName: 's', host: 'h', port: 1, name: 'h' }],
];

describe('runProxiedRequest dispatch', () => {
  it.each(cases)('routes kind=%s to its runner', async (_kind, config) => {
    const res = await runProxiedRequest(config, target);
    expect(await res.text()).toBe('ok');
  });
});
