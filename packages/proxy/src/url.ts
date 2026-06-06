// Parse subscription-style proxy URIs into the discriminated `ProxyConfig`
// union. Supported schemes: http, https, socks5, ss, trojan, vless. The
// formatter (the inverse direction) lives next to it once task 7 lands.
//
// Discrimination notes:
//   * `ss://` covers both legacy AEAD-2018 (userinfo is base64(method:pwd))
//     and 2022-blake3 variants (userinfo is literal `method:base64key`).
//     We try the 2022 form first by inspecting the raw method prefix.
//   * `vless://` carries its real transport in `?type=` and `?security=`;
//     we route to `vless-tcp`, `vless-ws`, or `reality` from those.
//
// Required-field validation lives here so callers receive a typed
// `ProxyConfig` they can dial without re-checking, e.g. REALITY mandates
// pbk / fp / sni up front.

import type {
  HttpProxyConfig,
  ProxyConfig,
  RealityProxyConfig,
  Shadowsocks2022ProxyConfig,
  ShadowsocksProxyConfig,
  Socks5ProxyConfig,
  Ss2022Method,
  SsMethod,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
} from './proxy-config.js'

const SS_METHODS: ReadonlySet<string> = new Set<SsMethod>([
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
])

const SS2022_METHODS: ReadonlySet<string> = new Set<Ss2022Method>([
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
])

export const parseProxyUri = (uri: string): ProxyConfig => {
  const url = new URL(uri)
  const host = url.hostname
  const port = resolvePort(url, uri)
  const name = url.hash
    ? decodeURIComponent(url.hash.slice(1))
    : `${host}:${port}`

  switch (url.protocol) {
    case 'http:': return parseHttp(url, host, port, name, false)
    case 'https:': return parseHttp(url, host, port, name, true)
    case 'socks5:': return parseSocks5(url, host, port, name)
    case 'ss:': return parseSs(url, host, port, name)
    case 'trojan:': return parseTrojan(url, host, port, name)
    case 'vless:': return parseVless(url, host, port, name)
    default:
      throw new Error(`Unknown scheme: ${url.protocol.replace(/:$/, '')}`)
  }
}

const resolvePort = (url: URL, uri: string): number => {
  if (url.port) return Number(url.port)
  if (url.protocol === 'https:') return 443
  throw new Error(`port required: ${uri}`)
}

const parseHttp = (
  url: URL,
  host: string,
  port: number,
  name: string,
  tls: boolean,
): HttpProxyConfig => {
  const config: HttpProxyConfig = { kind: 'http', tls, host, port, name }
  if (url.username) config.username = decodeURIComponent(url.username)
  if (url.password) config.password = decodeURIComponent(url.password)
  return config
}

const parseSocks5 = (
  url: URL,
  host: string,
  port: number,
  name: string,
): Socks5ProxyConfig => {
  const config: Socks5ProxyConfig = { kind: 'socks5', host, port, name }
  if (url.username) config.username = decodeURIComponent(url.username)
  if (url.password) config.password = decodeURIComponent(url.password)
  return config
}

const parseSs = (
  url: URL,
  host: string,
  port: number,
  name: string,
): ShadowsocksProxyConfig | Shadowsocks2022ProxyConfig => {
  // SS-2022 keeps `method:base64key` as plaintext userinfo. Detect by
  // checking whether the prefix before the first ':' is a known 2022
  // method; if so, the suffix is the raw base64 key (URL parsing already
  // split userinfo on the first ':' for us via username/password, and
  // percent-encoded any `=` padding on the way through).
  const username = decodeURIComponent(url.username)
  if (SS2022_METHODS.has(username)) {
    return {
      kind: 'ss2022',
      method: username as Ss2022Method,
      passwordBase64: decodeURIComponent(url.password),
      host,
      port,
      name,
    }
  }

  // Legacy: the entire userinfo is base64(method:password). The URL parser
  // would split on ':' if base64 padding put one in there, so recombine
  // the two halves before decoding.
  const userinfo = url.password
    ? `${url.username}:${decodeURIComponent(url.password)}`
    : url.username
  const decoded = base64Decode(userinfo)
  const sep = decoded.indexOf(':')
  if (sep < 0) throw new Error(`malformed ss userinfo: ${url.username}`)
  const method = decoded.slice(0, sep)
  if (!SS_METHODS.has(method)) {
    throw new Error(`unknown ss method: ${method}`)
  }
  return {
    kind: 'ss',
    method: method as SsMethod,
    password: decoded.slice(sep + 1),
    host,
    port,
    name,
  }
}

const parseTrojan = (
  url: URL,
  host: string,
  port: number,
  name: string,
): TrojanProxyConfig => {
  const config: TrojanProxyConfig = {
    kind: 'trojan',
    password: decodeURIComponent(url.username),
    host,
    port,
    name,
  }
  const sni = url.searchParams.get('sni')
  if (sni) config.sni = sni
  const allowInsecure = url.searchParams.get('allowInsecure')
  if (allowInsecure !== null) config.allowInsecure = allowInsecure === '1'
  return config
}

const parseVless = (
  url: URL,
  host: string,
  port: number,
  name: string,
): VlessTcpTlsProxyConfig | VlessWsTlsProxyConfig | RealityProxyConfig => {
  const uuid = decodeURIComponent(url.username)
  const type = url.searchParams.get('type') ?? 'tcp'
  const security = url.searchParams.get('security') ?? 'tls'
  const sni = url.searchParams.get('sni') ?? undefined
  const fp = url.searchParams.get('fp') ?? undefined

  if (type === 'tcp' && security === 'reality') {
    return parseReality(url, host, port, name, uuid, fp, sni)
  }
  if (type === 'tcp' && security === 'tls') {
    const config: VlessTcpTlsProxyConfig = {
      kind: 'vless-tcp',
      uuid,
      host,
      port,
      name,
    }
    if (sni) config.sni = sni
    if (fp) config.fingerprint = fp
    return config
  }
  if (type === 'ws' && security === 'tls') {
    const path = url.searchParams.get('path') ?? '/'
    const config: VlessWsTlsProxyConfig = {
      kind: 'vless-ws',
      uuid,
      host,
      port,
      name,
      path,
    }
    if (sni) config.sni = sni
    if (fp) config.fingerprint = fp
    const wsHost = url.searchParams.get('host')
    if (wsHost) config.wsHost = wsHost
    return config
  }
  throw new Error(
    `unsupported vless transport: type=${type}, security=${security}`,
  )
}

const parseReality = (
  url: URL,
  host: string,
  port: number,
  name: string,
  uuid: string,
  fp: string | undefined,
  sni: string | undefined,
): RealityProxyConfig => {
  const pbk = url.searchParams.get('pbk')
  if (!pbk) throw new Error('reality requires pbk')
  if (!fp) throw new Error('reality requires fp')
  if (!sni) throw new Error('reality requires sni')
  const config: RealityProxyConfig = {
    kind: 'reality',
    uuid,
    host,
    port,
    name,
    publicKey: pbk,
    fingerprint: fp,
    serverName: sni,
  }
  const sid = url.searchParams.get('sid')
  if (sid) config.shortId = sid
  const spx = url.searchParams.get('spx')
  if (spx) config.spiderX = spx
  return config
}

// `atob` is universally available in Workers, Node 22+, and browsers.
const base64Decode = (s: string): string => atob(s)
