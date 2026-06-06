// Worker harness for proxy-dial experiments.

import { connect } from 'cloudflare:sockets'
import { runHttp1 } from './http1.js'
import { runHttp1Stream } from './http1-stream.js'
import { userspaceTls } from './userspace-tls.js'
import { runRustlsDirect } from './userspace-tls-rustls.js'
import { runHttpConnect } from './proxies/http-connect.js'
import { runSocks5 } from './proxies/socks5.js'
import { runTrojan } from './proxies/trojan.js'
import { runVlessTcpTls, runVlessWsTls } from './proxies/vless.js'
import { runShadowsocks } from './proxies/shadowsocks.js'
import { runShadowsocks2022 } from './proxies/shadowsocks-2022.js'
import { runReality } from './proxies/reality.js'
import { resolveTarget, type TargetSpec } from './targets.js'

export type ProxyRunner = (target: TargetSpec) => Promise<Response>

const PROXY_HOST = '23.145.36.136.sslip.io'
const PROXY_HOST_PLAIN = '23.145.36.136'
const TEST_UUID = '850a5cd2-688b-4448-bc81-a25e9a4d8997'

const RUNNERS: Record<string, ProxyRunner> = {
  direct: async (target) => {
    return await fetch(target.url, { headers: target.headers })
  },
  'native-direct': async (target) => {
    const sock = connect(
      { hostname: target.host, port: target.port },
      { secureTransport: target.tls ? 'on' : 'off', allowHalfOpen: true },
    )
    return await runHttp1(sock, target)
  },
  'native-starttls': async (target) => {
    if (!target.tls) throw new Error('native-starttls only valid for TLS targets')
    let sock = connect(
      { hostname: target.host, port: target.port },
      { secureTransport: 'starttls', allowHalfOpen: true },
    )
    sock = sock.startTls({ expectedServerHostname: target.host })
    return await runHttp1(sock, target)
  },
  'userspace-direct': async (target) => {
    if (!target.tls) throw new Error('userspace-direct only valid for TLS targets')
    const sock = connect(
      { hostname: target.host, port: target.port },
      { secureTransport: 'off', allowHalfOpen: true },
    )
    const tls = await userspaceTls(sock, { host: target.sni ?? target.host })
    return await runHttp1Stream(tls, target)
  },
  'rustls-direct': async (target) => await runRustlsDirect(target),
  'http-connect': async (target) =>
    await runHttpConnect({
      proxyHost: PROXY_HOST_PLAIN,
      proxyPort: 56010,
      proxyTls: false,
      auth: { username: 'testuser', password: 'proxy-test-pw' },
      target,
    }),
  'http-connect-tls': async (target) =>
    await runHttpConnect({
      proxyHost: PROXY_HOST,
      proxyPort: 56017,
      proxyTls: true,
      auth: { username: 'testuser', password: 'proxy-test-pw' },
      target,
    }),
  socks5: async (target) =>
    await runSocks5({
      proxyHost: PROXY_HOST_PLAIN,
      proxyPort: 56011,
      auth: { username: 'testuser', password: 'proxy-test-pw' },
      target,
    }),
  trojan: async (target) =>
    await runTrojan({
      serverHost: PROXY_HOST,
      serverPort: 56012,
      password: 'proxy-test-trojan-pw',
      target,
    }),
  'vless-tcp-tls': async (target) =>
    await runVlessTcpTls({
      serverHost: PROXY_HOST,
      serverPort: 56013,
      uuid: TEST_UUID,
      target,
    }),
  'vless-ws-tls': async (target) =>
    await runVlessWsTls({
      serverHost: PROXY_HOST,
      serverPort: 56014,
      uuid: TEST_UUID,
      path: '/vlessws',
      target,
    }),
  'ss-aead-chacha': async (target) =>
    await runShadowsocks({
      serverHost: PROXY_HOST_PLAIN,
      serverPort: 56015,
      method: 'chacha20-ietf-poly1305',
      password: 'Xm6v6YwWu96Flmqqsl8hjPDL4MbigQBTkIW49xSa/gY=',
      target,
    }),
  'ss-aead-aes': async (target) =>
    await runShadowsocks({
      serverHost: PROXY_HOST_PLAIN,
      serverPort: 56018,
      method: 'aes-256-gcm',
      password: 'Xm6v6YwWu96Flmqqsl8hjPDL4MbigQBTkIW49xSa/gY=',
      target,
    }),
  'ss-2022': async (target) =>
    await runShadowsocks2022({
      serverHost: PROXY_HOST_PLAIN,
      serverPort: 56001,
      method: '2022-blake3-aes-256-gcm',
      password: 'Pgevx6VbhdOmFEK7jeJYe83goa66T0HHQFfIrLtJuDo=',
      target,
    }),
  reality: async (target) =>
    await runReality({
      serverHost: PROXY_HOST_PLAIN,
      serverPort: 56016,
      publicKeyB64Url: 'Z0U6ShVrG5W4dx3xBCgvvUJB3iDjkqKsJjgSoPgZjXY',
      shortIdHex: 'e458728e679958a4',
      spoofSni: 'www.cloudflare.com',
      uuid: TEST_UUID,
      target,
    }),
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length === 0 || parts[0] === '') {
      return new Response(
        JSON.stringify({ ok: true, runners: Object.keys(RUNNERS) }, null, 2),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (parts[0] === 'bench') {
      // /bench/{runner}/{target} — drain the upstream body inside the Worker
      // and return only timings. No streaming hand-off, so the wall time
      // measured here covers all worker work for the request and bills
      // accordingly under Workers' duration + CPU model.
      const runnerName = parts[1] ?? ''
      const targetName = parts[2] ?? 'echo'
      const runner = RUNNERS[runnerName]
      if (!runner) return new Response(`unknown runner: ${runnerName}`, { status: 404 })
      const target = resolveTarget(targetName)
      if (!target) return new Response(`unknown target: ${targetName}`, { status: 404 })
      try {
        const t0 = performance.now()
        const upstream = await runner(target)
        const tHeaders = performance.now()
        let bytes = 0
        let firstByteAt: number | null = null
        const reader = upstream.body!.getReader()
        while (true) {
          const r = await reader.read()
          if (r.done) break
          if (firstByteAt === null) firstByteAt = performance.now()
          bytes += r.value.byteLength
        }
        const tDone = performance.now()
        return new Response(
          JSON.stringify({
            runner: runnerName,
            target: targetName,
            status: upstream.status,
            bytes,
            handshake_and_headers_ms: +(tHeaders - t0).toFixed(2),
            ttfb_ms: firstByteAt === null ? null : +(firstByteAt - t0).toFixed(2),
            total_ms: +(tDone - t0).toFixed(2),
            body_drain_ms: firstByteAt === null ? null : +(tDone - firstByteAt).toFixed(2),
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      } catch (e) {
        const stack = e instanceof Error ? e.stack ?? `${e.name}: ${e.message}` : String(e)
        return new Response(stack, { status: 502, headers: { 'content-type': 'text/plain' } })
      }
    }
    const runnerName = parts[0]!
    const targetName = parts[1] ?? 'echo'
    const runner = RUNNERS[runnerName]
    if (!runner) return new Response(`unknown runner: ${runnerName}`, { status: 404 })
    const target = resolveTarget(targetName)
    if (!target) return new Response(`unknown target: ${targetName}`, { status: 404 })
    try {
      const t0 = Date.now()
      const upstream = await runner(target)
      const ms = Date.now() - t0
      const headers = new Headers(upstream.headers)
      headers.set('x-proxy-runner', runnerName)
      headers.set('x-proxy-target', targetName)
      headers.set('x-proxy-elapsed-ms', String(ms))
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (e) {
      const stack = e instanceof Error ? e.stack ?? `${e.name}: ${e.message}` : String(e)
      return new Response(stack, { status: 502, headers: { 'content-type': 'text/plain' } })
    }
  },
} satisfies ExportedHandler
