import { describe, expect, it } from 'vitest'

import { formatProxyUri, parseProxyUri } from './url.js'

describe('parseProxyUri', () => {
  it('parses HTTP CONNECT plain', () => {
    expect(parseProxyUri('http://user:pass@example.com:3128#name')).toEqual({
      kind: 'http',
      tls: false,
      host: 'example.com',
      port: 3128,
      username: 'user',
      password: 'pass',
      name: 'name',
    })
  })

  it('parses HTTPS CONNECT', () => {
    expect(parseProxyUri('https://example.com:443')).toEqual({
      kind: 'http',
      tls: true,
      host: 'example.com',
      port: 443,
      name: 'example.com:443',
    })
  })

  it('parses SOCKS5 with auth', () => {
    expect(parseProxyUri('socks5://u:p@1.2.3.4:1080#jp')).toEqual({
      kind: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p',
      name: 'jp',
    })
  })

  it('parses Shadowsocks legacy base64(method:password)', () => {
    // base64('aes-256-gcm:secret') = 'YWVzLTI1Ni1nY206c2VjcmV0'
    expect(parseProxyUri('ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#tag'))
      .toEqual({
        kind: 'ss',
        method: 'aes-256-gcm',
        password: 'secret',
        host: '1.2.3.4',
        port: 8388,
        name: 'tag',
      })
  })

  it('parses Shadowsocks 2022', () => {
    // userinfo = '2022-blake3-aes-128-gcm:<base64key>'
    expect(parseProxyUri(
      'ss://2022-blake3-aes-128-gcm:MTIzNDU2Nzg5MGFiY2RlZg==@1.2.3.4:8388#tag',
    )).toEqual({
      kind: 'ss2022',
      method: '2022-blake3-aes-128-gcm',
      passwordBase64: 'MTIzNDU2Nzg5MGFiY2RlZg==',
      host: '1.2.3.4',
      port: 8388,
      name: 'tag',
    })
  })

  it('parses Trojan', () => {
    expect(parseProxyUri(
      'trojan://pw@example.com:443?sni=example.com&allowInsecure=0#t',
    )).toEqual({
      kind: 'trojan',
      password: 'pw',
      host: 'example.com',
      port: 443,
      sni: 'example.com',
      allowInsecure: false,
      name: 't',
    })
  })

  it('parses VLESS TCP+TLS', () => {
    const uri =
      'vless://aaaa-uuid@h:443?type=tcp&security=tls&sni=h&fp=chrome#v'
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-tcp',
      uuid: 'aaaa-uuid',
      host: 'h',
      port: 443,
      sni: 'h',
      fingerprint: 'chrome',
      name: 'v',
    })
  })

  it('parses VLESS WS+TLS', () => {
    const uri =
      'vless://u@h:443?type=ws&security=tls&host=front&path=%2Fws&sni=h&fp=chrome#vw'
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-ws',
      uuid: 'u',
      host: 'h',
      port: 443,
      sni: 'h',
      fingerprint: 'chrome',
      wsHost: 'front',
      path: '/ws',
      name: 'vw',
    })
  })

  it('parses VLESS REALITY', () => {
    const uri =
      'vless://u@h:443?type=tcp&security=reality&pbk=PUB&fp=chrome&sni=site&sid=ab&spx=%2F#r'
    expect(parseProxyUri(uri)).toEqual({
      kind: 'reality',
      uuid: 'u',
      host: 'h',
      port: 443,
      publicKey: 'PUB',
      fingerprint: 'chrome',
      serverName: 'site',
      shortId: 'ab',
      spiderX: '/',
      name: 'r',
    })
  })

  it('throws on unknown scheme', () => {
    expect(() => parseProxyUri('weird://x:1')).toThrow(/scheme/i)
  })

  it('throws on missing required REALITY pbk', () => {
    expect(() =>
      parseProxyUri('vless://u@h:443?type=tcp&security=reality&fp=chrome&sni=s'),
    ).toThrow(/pbk/)
  })
})

describe('formatProxyUri', () => {
  const cases: string[] = [
    'http://user:pass@example.com:3128#name',
    'https://example.com:443',
    'socks5://u:p@1.2.3.4:1080#jp',
    'ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#tag',
    'ss://2022-blake3-aes-128-gcm:MTIzNDU2Nzg5MGFiY2RlZg==@1.2.3.4:8388#tag',
    'trojan://pw@example.com:443?sni=example.com&allowInsecure=0#t',
    'vless://aaaa-uuid@h:443?type=tcp&security=tls&sni=h&fp=chrome#v',
    'vless://u@h:443?type=ws&security=tls&host=front&path=%2Fws&sni=h&fp=chrome#vw',
    'vless://u@h:443?type=tcp&security=reality&pbk=PUB&fp=chrome&sni=site&sid=ab&spx=%2F#r',
  ]

  it.each(cases)('round-trips %s', (uri) => {
    const config = parseProxyUri(uri)
    const formatted = formatProxyUri(config)
    expect(parseProxyUri(formatted)).toEqual(config)
  })
})
