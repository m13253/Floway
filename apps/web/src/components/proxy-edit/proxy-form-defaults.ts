// Per-kind seeds the form panel falls back to when the operator switches
// the protocol selector or types into a kind-specific field for the first
// time. The values must satisfy `formatProxyUri` so the URL field stays
// regenerable on every keystroke — empty UUIDs and missing required
// REALITY/SS fields are kept empty here, and the page-level guard refuses
// to save until the URL parses cleanly again.

import type {
  HttpProxyConfig,
  ProxyConfig,
  RealityProxyConfig,
  Shadowsocks2022ProxyConfig,
  ShadowsocksProxyConfig,
  Socks5ProxyConfig,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
} from '@floway-dev/proxy/proxy-config';

// `kind: 'http'` covers both plain HTTP CONNECT and HTTPS CONNECT via the
// `tls` flag. The form selector exposes the two separately so an operator
// picks the wire shape directly rather than toggling a checkbox.
export type FormKind =
  | 'http' | 'https'
  | 'socks5'
  | 'ss' | 'ss2022'
  | 'trojan'
  | 'vless-tcp' | 'vless-ws'
  | 'reality';

export const FORM_KIND_LABELS: Record<FormKind, string> = {
  'http': 'HTTP',
  'https': 'HTTPS',
  'socks5': 'SOCKS5',
  'ss': 'Shadowsocks',
  'ss2022': 'Shadowsocks 2022',
  'trojan': 'Trojan',
  'vless-tcp': 'VLESS / TLS',
  'vless-ws': 'VLESS / WebSocket',
  'reality': 'VLESS / REALITY',
};

export const formKindOf = (config: ProxyConfig): FormKind => {
  if (config.kind === 'http') return config.tls ? 'https' : 'http';
  return config.kind;
};

interface DefaultsContext {
  host: string;
  port: number;
  name: string;
}

const portFor = (kind: FormKind, current: number): number => {
  if (current > 0) return current;
  switch (kind) {
  case 'http': return 8080;
  case 'https':
  case 'trojan':
  case 'vless-tcp':
  case 'vless-ws':
  case 'reality':
    return 443;
  case 'socks5': return 1080;
  case 'ss':
  case 'ss2022':
    return 8388;
  }
};

export const defaultsFor = (kind: FormKind, ctx: DefaultsContext): ProxyConfig => {
  const base = { host: ctx.host, port: portFor(kind, ctx.port), name: ctx.name };
  switch (kind) {
  case 'http': {
    const c: HttpProxyConfig = { kind: 'http', tls: false, ...base };
    return c;
  }
  case 'https': {
    const c: HttpProxyConfig = { kind: 'http', tls: true, ...base };
    return c;
  }
  case 'socks5': {
    const c: Socks5ProxyConfig = { kind: 'socks5', ...base };
    return c;
  }
  case 'ss': {
    const c: ShadowsocksProxyConfig = {
      kind: 'ss', method: 'aes-256-gcm', password: '', ...base,
    };
    return c;
  }
  case 'ss2022': {
    const c: Shadowsocks2022ProxyConfig = {
      kind: 'ss2022', method: '2022-blake3-aes-128-gcm', passwordBase64: '', ...base,
    };
    return c;
  }
  case 'trojan': {
    const c: TrojanProxyConfig = { kind: 'trojan', password: '', ...base };
    return c;
  }
  case 'vless-tcp': {
    const c: VlessTcpTlsProxyConfig = { kind: 'vless-tcp', uuid: '', ...base };
    return c;
  }
  case 'vless-ws': {
    const c: VlessWsTlsProxyConfig = {
      kind: 'vless-ws', uuid: '', path: '/', ...base,
    };
    return c;
  }
  case 'reality': {
    const c: RealityProxyConfig = {
      kind: 'reality',
      uuid: '',
      publicKey: '',
      serverName: '',
      ...base,
    };
    return c;
  }
  }
};

// Switching protocols preserves transport coordinates (host, port, name)
// and resets every kind-specific field. Any port the operator already
// typed carries over verbatim — clobbering it would surprise someone who
// is just toggling between vless-tcp and vless-ws — and only an unset
// port (0) is replaced with the new kind's canonical default.
export const switchKind = (current: ProxyConfig, next: FormKind): ProxyConfig => {
  return defaultsFor(next, {
    host: current.host,
    port: current.port,
    name: current.name,
  });
};

export const isValidUuid = (s: string): boolean => {
  const hex = s.replace(/-/g, '');
  return hex.length === 32 && /^[0-9a-fA-F]+$/.test(hex);
};

export const isValidPort = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= 65535;
