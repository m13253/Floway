// Discriminated union over every proxy protocol packages/proxy supports.
// kind matches the canonical scheme used in the URI form (see url.ts).
// Adding a new protocol = add a variant here, a parser branch in url.ts,
// and a dispatch branch in dialer.ts.

export type ProxyConfig =
  | HttpProxyConfig
  | Socks5ProxyConfig
  | ShadowsocksProxyConfig
  | Shadowsocks2022ProxyConfig
  | TrojanProxyConfig
  | VlessTcpTlsProxyConfig
  | VlessWsTlsProxyConfig
  | RealityProxyConfig;

interface ProxyConfigBase {
  /** Display label; equals the URI fragment if present, else "<host>:<port>". */
  name: string;
  host: string;
  port: number;
}

export interface HttpProxyConfig extends ProxyConfigBase {
  kind: 'http';
  /** When true, outer leg is TLS (HTTPS CONNECT). */
  tls: boolean;
  username?: string;
  password?: string;
}

export interface Socks5ProxyConfig extends ProxyConfigBase {
  kind: 'socks5';
  username?: string;
  password?: string;
}

export type SsMethod = 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-ietf-poly1305';

/**
 * Every SsMethod literal in declaration order. Frozen so consumers can
 * iterate options (UI dropdowns, config validation) without re-deriving
 * the list from the type. Keep in sync with SsMethod.
 */
export const SS_METHODS: readonly SsMethod[] = Object.freeze([
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
] as const);

export interface ShadowsocksProxyConfig extends ProxyConfigBase {
  kind: 'ss';
  method: SsMethod;
  password: string;
}

export type Ss2022Method =
  | '2022-blake3-aes-128-gcm'
  | '2022-blake3-aes-256-gcm'
  | '2022-blake3-chacha20-poly1305';

/**
 * Every Ss2022Method literal in declaration order. See SS_METHODS above
 * for the contract.
 */
export const SS2022_METHODS: readonly Ss2022Method[] = Object.freeze([
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
] as const);

export interface Shadowsocks2022ProxyConfig extends ProxyConfigBase {
  kind: 'ss2022';
  method: Ss2022Method;
  /** Base64-encoded PSK; the dialer decodes once at connect time. */
  passwordBase64: string;
}

export interface TrojanProxyConfig extends ProxyConfigBase {
  kind: 'trojan';
  password: string;
  sni?: string;
  allowInsecure?: boolean;
}

export interface VlessTcpTlsProxyConfig extends ProxyConfigBase {
  kind: 'vless-tcp';
  uuid: string;
  sni?: string;
}

export interface VlessWsTlsProxyConfig extends ProxyConfigBase {
  kind: 'vless-ws';
  uuid: string;
  sni?: string;
  /** WebSocket Host header; defaults to host. */
  wsHost?: string;
  /** WebSocket path. */
  path: string;
}

export interface RealityProxyConfig extends ProxyConfigBase {
  kind: 'reality';
  uuid: string;
  publicKey: string;        // pbk in URI form
  serverName: string;       // sni — required for REALITY
  shortId?: string;         // sid
}
