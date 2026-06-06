# Phase 1 Success: All 13 Non-REALITY Runners Pass

Deployed at `https://proxy-dial-test.menci.workers.dev`.

## Matrix results

| runner | echo | sse | chunked | large (5MB) | abort | sleep-then-200 | wrong-sni | expired |
|---|---|---|---|---|---|---|---|---|
| direct (Worker fetch) | 200 | ok | ok | 200/5MB | partial | 200 | n/a | n/a |
| native-direct (workerd TLS) | 200 | ok | ok | 200/5MB | 200/22 | 200 | n/a | n/a |
| native-starttls | 200 | ok | ok | 200/5MB | 200/22 | 200 | n/a | n/a |
| userspace-direct (reclaim TLS) | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | cert error ✓ |
| http-connect (plain → HTTPS) | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | cert error ✓ |
| http-connect-tls (HTTPS → HTTPS, TLS-in-TLS) | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | n/a |
| socks5 | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | n/a |
| trojan | 200 | ok | ok | 200/5MB | 200/0 | 200 | rejected ✓ | n/a |
| vless-tcp-tls | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | n/a |
| vless-ws-tls | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | n/a |
| ss-aead-chacha (chacha20-poly1305) | 200 | ok | ok | 200/5MB | 200/22 | 200 | rejected ✓ | n/a |
| ss-aead-aes (aes-256-gcm) | 200 | ok | ok | 200/5MB | 200/22 | 200 | n/a | n/a |
| ss-2022 (2022-blake3-aes-256-gcm) | 200 | ok | ok | 200/5MB | 200/22 | 200 | n/a | n/a |

## Key findings

1. **`socket.startTls()` is broken on Workers production edge** when called after
   any read or write on the socket. We therefore cannot rely on it for any
   proxy that requires post-handshake bytes before TLS upgrade.
   Reproduction details in `05-FINDING-startTls-edge-bug.md`.

2. **The fix is userspace TLS via `@reclaimprotocol/tls`** layered on top of
   the proxy's plaintext byte stream. ~160 KB gzipped, pure JS using Web
   Crypto + `@noble/*`, validates against Mozilla root CAs. Streams 5 MiB body
   in ~2 seconds; SSE/chunked event boundaries preserved.

3. **TLS-in-TLS (HTTP CONNECT over HTTPS proxy → HTTPS upstream)** is achieved
   by letting workerd's outer TLS handle the proxy hop, then layering
   userspace TLS on the post-CONNECT bytes. workerd's `secureTransport: 'on'`
   does not call `startTls()` so it isn't affected by the edge bug.

4. **Workerd's outer TLS splits the first application-data write into a small
   leading record (~4 bytes) followed by the rest.** sing-box's Trojan
   inbound short-reads its 56-byte key on this and rejects with
   "bad request size: fallback disabled". Workaround: do the outer TLS in
   userspace too, so we control the record framing. Trojan now succeeds.

5. **VLESS-WS-TLS** binary messages arrive as `Blob` from workerd's outbound
   WebSocket (not `ArrayBuffer`). Must `await blob.arrayBuffer()` to read.

6. **VLESS reply prefix stripping must be lazy** — the prefix is sent only
   after the upstream sees the inner request, so eagerly awaiting it before
   userspace TLS writes its ClientHello deadlocks.

7. **SIP022 requires non-empty padding or initial payload** in the first
   request frame — empty pad/payload triggers "missing payload or padding".
   16 bytes of random padding fixes it.

8. **SIP022 max payload per record is `0xffff`**, not the AEAD-2018
   `0x3fff` — sing-box sends up to 32 KiB records; we must accept them.

9. **Cert validation works**: `userspace-direct/expired` returns
   "Certificate *.badssl.com is outside validity" via reclaim's verifier.
   wrong-sni dial fails at every layer.

## Architecture summary

```
┌──────────────────────────────────────────────────────────────────┐
│ Worker fetch handler                                             │
└─┬────────────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│ ProxyRunner (one per protocol)                                   │
│ Builds the protocol's request header,                            │
│ delegates the post-header byte stream to a transform that frames │
│ outgoing data and unframes incoming data (or, for plain-relay    │
│ proxies, just a raw passthrough).                                │
└─┬────────────────────────────────────────────────────────────────┘
  │  { readable, writable } — plaintext bytes destined for upstream
  ▼
┌──────────────────────────────────────────────────────────────────┐
│ userspaceTls (@reclaimprotocol/tls)                              │
│ Performs the inner TLS 1.3 handshake to the upstream HTTPS host. │
│ Returns another { readable, writable } of decrypted app data.    │
└─┬────────────────────────────────────────────────────────────────┘
  │  HTTP/1.1 plaintext
  ▼
┌──────────────────────────────────────────────────────────────────┐
│ runHttp1Stream                                                   │
│ Hand-written HTTP/1.1 client: status/headers parse, content-     │
│ length/chunked/until-EOF body framing. Returns Response.         │
└──────────────────────────────────────────────────────────────────┘
```

For Trojan (and any future protocol where workerd's TLS record-splitting
fights the proxy), the outer TLS is also done in userspace:

```
plain TCP via cloudflare:sockets
  → userspaceTls(host = proxy)                  ← outer TLS in userspace
    → write protocol header
    → userspaceTls(host = upstream, prefix=hdr) ← inner TLS in userspace
      → runHttp1Stream
```
