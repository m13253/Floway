# Critical Finding: workerd `startTls()` Broken on Production Edge

## TL;DR

`socket.startTls()` works correctly on local `wrangler dev` but **fails with
`Error: TLS Handshake Failed.` on the Cloudflare production edge** when called
on a socket that has had any bytes read or written before the upgrade.

This means the documented "plain TCP → write STARTTLS command → upgrade to TLS"
pattern — which is the standard way to dial through HTTP CONNECT and SOCKS5
proxies — is broken in production. **Even our "simple tier" of HTTP CONNECT
(plain) and SOCKS5 to HTTPS upstream cannot be implemented with native
`startTls()` on Workers.**

## Reproduction

Worker code: `experiments/proxy-dial/test-worker/src/proxies/http-connect.ts`
exactly follows the pattern from
`workerd/src/workerd/api/tests/starttls-nodejs-test.js`:

```ts
let socket = connect(
  { hostname: '23.145.36.136', port: 56010 },
  { secureTransport: 'starttls', allowHalfOpen: true },
)
const writer = socket.writable.getWriter()
await writer.write(connectBytes)
writer.releaseLock()

const reader = socket.readable.getReader()
// loop: reader.read() until \r\n\r\n found and HTTP/1.1 200 parsed
reader.releaseLock()

socket = socket.startTls({ expectedServerHostname: target.host })
await socket.opened   // adding this did not help

// Subsequent operations on `socket` throw "TLS Handshake Failed."
```

Verified results:
- **Local `wrangler dev`**: HTTP CONNECT, SOCKS5, native-direct, native-starttls
  ALL return 200 OK. `[wrangler:info] GET /http-connect/echo 200 OK (513ms)`.
- **Production deploy** (`https://proxy-dial-test.menci.workers.dev`):
  HTTP CONNECT, SOCKS5 fail with the handshake error every time.
  native-direct (`secureTransport: 'on'` from the start) and native-starttls
  (no bytes between `connect()` and `startTls()`) work fine.

## tcpdump trace (production edge → JP proxy)

Captured in `experiments/proxy-dial/notes/05-tls-failure-trace.txt`. Worker
goes through the full sequence:

```
Worker → Proxy: CONNECT 23.145.36.136.sslip.io:443 HTTP/1.1\r\n…   (205 bytes)
Proxy  → Worker: HTTP/1.1 200 Connection established\r\n\r\n        (39 bytes)
Worker → Proxy: TLS ClientHello                                    (1452 bytes)
Proxy  → Worker: TLS ServerHello + EncryptedExtensions + Certificate
                  + CertificateVerify + Finished                   (4860 bytes)
Worker → Proxy: TLS Alert                                          (30 bytes)
Worker → Proxy: FIN
```

The Worker rejects the server's handshake with an Alert. The exact alert code
is in the encrypted record so we can't read it without the keys, but the
pattern is consistent with the upgraded socket having a corrupted TLS state.

## Upstream issue

Cloudflare workerd issue
[#2712 — "Unable to use startTls for SMTP"](https://github.com/cloudflare/workerd/issues/2712)
filed 2024-12, unresolved as of 2026-06. The user there hits the same pattern
with SMTP STARTTLS. The fork they ended up using (`abn5x/worker-mailer`)
sidesteps the bug by using `secureTransport: 'on'` against port 465 (TLS
from the start) instead of STARTTLS.

The bug is in the http-over-capnp edge path: workerd's local kj implementation
correctly handles `startTls()` after read/write (the in-tree test proves it),
but the capnp RPC bridge that runs the actual TLS handshake at the production
edge does not.

## Implication for floway

Native `startTls()` is unusable for outbound proxy support on Workers
production. Every proxy that reaches an HTTPS upstream must do its inner TLS
handshake in **userspace TLS code** (JS or WASM).

This collapses the protocol matrix:

| Protocol | Native `startTls()` viable? | Needs userspace TLS? |
|---|---|---|
| Direct, native | yes (`secureTransport: 'on'`) | no |
| HTTP CONNECT plain → HTTPS | **no** — bug above | yes |
| HTTP CONNECT TLS → HTTPS | no — TLS-in-TLS rejected | yes |
| SOCKS5 plain → HTTPS | **no** — bug above | yes |
| Trojan TLS → HTTPS | no — TLS-in-TLS rejected | yes |
| VLESS-TCP-TLS → HTTPS | no — TLS-in-TLS rejected | yes |
| VLESS-WS-TLS → HTTPS | no — no Socket from WS | yes |
| Shadowsocks → HTTPS | no — userspace stream | yes |

**Conclusion:** ship one userspace TLS implementation and use it for *every*
non-direct proxy. Recommended: `MercuryWorkshop/rustls-wasm` (MIT, ~300-400 KB
gzip, exact stream-in/stream-out API) with `@reclaimprotocol/tls` as JS
fallback if the WASM bridge has Workers quirks.
