# Proxy-Dial Feasibility on Cloudflare Workers — Final Report

## Bottom line

**All 14 proxy variants — including REALITY — work end-to-end on Cloudflare
Workers production**, validated against real HTTPS upstreams covering normal
HTTP/1.1, SSE streaming, chunked transfer, 5 MiB bodies, slow drips, mid-
response aborts, long deadlines, and certificate validation negatives.

| Protocol | Outer transport | Inner TLS to upstream | Status |
|---|---|---|---|
| direct (`fetch()`) | n/a | n/a | ✅ |
| native-direct | `secureTransport: "on"` | workerd native | ✅ |
| native-starttls | `connect()` + `socket.startTls()` (clean socket) | workerd native | ✅ |
| **userspace-direct** | plain TCP | userspace TLS via reclaim | ✅ |
| HTTP CONNECT (plain proxy) | plain TCP + CONNECT 2xx | userspace TLS | ✅ |
| HTTP CONNECT (HTTPS proxy) | workerd outer TLS + CONNECT 2xx | userspace TLS | ✅ |
| SOCKS5 | plain TCP + SOCKS5 handshake | userspace TLS | ✅ |
| Trojan | userspace outer TLS + Trojan header | userspace TLS | ✅ |
| VLESS / TCP+TLS | workerd outer TLS + VLESS header | userspace TLS | ✅ |
| VLESS / WS+TLS | `fetch(Upgrade: websocket)` + VLESS header | userspace TLS | ✅ |
| Shadowsocks AEAD-2018 (chacha20-poly1305) | plain TCP + AEAD framing | userspace TLS | ✅ |
| Shadowsocks AEAD-2018 (aes-256-gcm) | plain TCP + AEAD framing | userspace TLS | ✅ |
| Shadowsocks 2022 (`2022-blake3-aes-256-gcm`) | plain TCP + SIP022 framing | userspace TLS | ✅ |
| **REALITY** | plain TCP + uTLS-shaped ClientHello + AEAD-sealed session_id | userspace TLS | ✅ |

UDP-only protocols (Hysteria2, mKCP, QUIC, SOCKS5 UDP ASSOCIATE,
Shadowsocks-UDP) are out of scope on Workers — there is no UDP egress.

## Findings (in order of discovery)

### 1. Workers production `startTls()` is broken after any pre-bytes

`socket.startTls()` works correctly in `wrangler dev` but fails with
`Error: TLS Handshake Failed.` on the production edge whenever the socket
has had any bytes read or written before the upgrade. This is workerd
[issue #2712](https://github.com/cloudflare/workerd/issues/2712), unresolved
since 2024-12. The bug is in the http-over-capnp edge path: workerd's local
kj implementation handles `startTls()` after read/write correctly (the
in-tree `starttls-nodejs-test.js` proves it), but the capnp RPC bridge that
runs the actual TLS handshake at the edge does not.

**Implication:** every proxy that does any plaintext handshake (CONNECT
response, SOCKS5 handshake, Shadowsocks AEAD framing…) before the upstream
TLS cannot use native `startTls()` for the upstream HTTPS. We use userspace
TLS instead for all such cases.

### 2. workerd's outer TLS splits the first application write into a tiny leading record

When a Worker writes 87 bytes through workerd's TLS layer (Trojan header),
the wire shows two TLS records: a tiny one (~4 bytes plaintext) followed by
the rest. sing-box's Trojan inbound uses a single `conn.Read(key[:56])`
which short-reads on the 4-byte first record and rejects with
`bad request size: fallback disabled`.

**Workaround:** do the *outer* TLS in userspace too, so we control record
framing. Trojan now runs user→userspace TLS→sing-box→user→userspace TLS→upstream.
Other proxies (HTTP CONNECT, VLESS) tolerate fragmentation because their
servers `ReadFull`-style.

### 3. TLS-in-TLS via chained `startTls()` is a hard NO

`workerd/src/workerd/api/sockets.c++` line 336 throws:
```cpp
JSG_REQUIRE(secureTransport != SecureTransportKind::ON, TypeError,
            "Cannot startTls on a TLS socket.");
```
So we cannot upgrade a TLS socket. For HTTP CONNECT over HTTPS (TLS-in-TLS
case), the workaround is: workerd's outer TLS handles the proxy hop and
exposes plaintext bytes via `socket.readable/writable`; userspace TLS on
those bytes does the inner upstream handshake. workerd never sees TLS-in-
TLS; it just thinks the inner ClientHello is application data.

### 4. workerd outbound WebSocket delivers binary as `Blob`, not `ArrayBuffer`

`fetch(url, { headers: { Upgrade: 'websocket' } })` returns a WebSocket whose
`MessageEvent.data` is a `Blob` for binary frames. `await blob.arrayBuffer()`
unwraps it. Subtle: the standard pattern of `new Uint8Array(data)` produces
an empty array when `data` is a Blob (no error, just zero bytes), so the
adapter must dispatch on type explicitly.

### 5. VLESS reply prefix must be stripped lazily

VLESS server sends its reply prefix only after the upstream has produced
data. Eagerly awaiting the prefix before the inner TLS writes its
ClientHello deadlocks (no prefix → no upstream → no prefix). The fix is
to wrap the readable in a TransformStream that strips the prefix on first
pull, allowing the inner TLS handshake to drive the conversation forward.

### 6. SS-2022 quirks

- SIP022 requires non-empty padding *or* initial payload in the first
  request frame. Empty pad/payload triggers
  `bad request: missing payload or padding`. We add 16 random padding bytes.
- Per-record max payload is `0xffff`, not `0x3fff` (AEAD-2018's limit).
  sing-box sends 32 KiB records; the client must accept them.

### 7. reclaim-tls TLS 1.3 padding (investigated, not patched)

`@reclaimprotocol/tls@0.1.2` reads the inner content type as
`decrypted.plaintext[length-1]` without scanning back through the zero-
padding RFC 8446 §5.4 allows. We expected sing-box's REALITY to exercise
this path, but the live test matrix passes against sing-box without the
fix — sing-box does not in practice pad inner handshake records during
the REALITY handshake. We left the upstream code untouched after
verifying empirically that the path is not triggered. If a different
peer pads inner records this fix would be required; carry as a follow-up
if and when that surfaces.

### 8. Ed25519 signature scheme (not needed in production)

Sing-box's REALITY forges an Ed25519 server cert (TLS sig scheme `0x0807`).
We initially expected reclaim's missing `SUPPORTED_SIGNATURE_ALGS_MAP`
entry to break the handshake, but the REALITY path bypasses standard
certificate-signature verification entirely (see `onRecvCertificateVerify`
returning `false` in `protocols/reality.ts`). The signature_algorithms
extension we send doesn't advertise Ed25519, so the server never picks
it on the wire, and the cert-verify hook short-circuits before the alg
table is consulted. No patch is necessary.

### 9. REALITY's X25519 ECDHE reuses the TLS keyshare keypair

The REALITY spec doesn't generate a separate ephemeral keypair — it uses
the TLS handshake's `key_share` X25519 keypair for the auth-key derivation.
This required a third reclaim-tls patch: an `onKeyPairGenerated` hook that
captures the just-generated `CryptoKey` private-key for off-band Web Crypto
`deriveBits` against the server's REALITY public key.

### 10. Xray-style AAD construction has a counter-intuitive zero-fill step

The AEAD seal of session_id uses `hello.Raw` as AAD. But Xray zeroes the
session_id slot in `hello.Raw` *before* constructing the seal payload —
the AAD has zeros at offset 39..71 even though the `plaintext` argument
is the unsealed `[version, ts, shortId]`. Reproducing this exactly was
required for the server's AEAD-Open to succeed.

## reclaim-tls patches (cumulative)

`patches/@reclaimprotocol__tls.patch` ships five surface changes — three
new hooks, a `verifyHost` plumbing fix, and a hot-path performance stub:

- `onClientHelloPack(bytes, ctx) → bytes?` — mutate the ClientHello after
  pack but before transcript hash. REALITY uses this to seal session_id.
- `onRecvCertificateVerify({ certificates, signature, algorithm, signatureData }) → false?` — replace the standard signature check with a custom verifier; return `false` to skip the default check. REALITY uses this to skip chain verification.
- `onKeyPairGenerated(keyType, keyPair, algorithm) → keyPair?` — capture or
  replace the keyshare keypair as it is generated. REALITY captures the
  X25519 private CryptoKey for off-band ECDHE.
- `startHandshake(opts)` accepts `sessionId` and `random` overrides.
  REALITY uses both to preset the ClientHello's session_id slot before
  the seal hook runs and the random for HKDF salt.
- `verifyHost` is threaded into `verifyCertificateChain` so SNI and
  cert-validation hostname can diverge. Consumed by every protocol
  runner that drives userspace TLS to an upstream HTTPS endpoint
  (http-connect, socks5, trojan, vless-core); enables domain fronting
  and dial-by-IP shapes via `TargetSpec.tlsVerifyHost`.
- `toHexStringWithWhitespace` is stubbed to a `<NN bytes>` summary —
  reclaim's hot path called the original on every TLS record from
  `logger.trace(...)`, where the args are eagerly evaluated even when
  trace is a no-op (~75% of CPU on a 5 MiB upload before the stub).

The patch is pinned to `@reclaimprotocol/tls@0.1.2` in
`pnpm-workspace.yaml`'s `patchedDependencies` so a future minor bump
forces a deliberate reapply rather than silently shifting line numbers.
The hooks are generic — every one is something upstream reclaim should
accept. We carry them as a vendored patch for now; can upstream as a PR.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Worker fetch handler                                       │
└─┬──────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│ ProxyRunner — one per protocol                             │
│   Establishes the proxy hop, returns {readable, writable} │
│   carrying plaintext bytes destined for the upstream.     │
└─┬──────────────────────────────────────────────────────────┘
  │  byte stream (post-proxy-handshake plaintext)
  ▼
┌────────────────────────────────────────────────────────────┐
│ userspaceTls (@reclaimprotocol/tls + patches)              │
│   Performs TLS 1.3 handshake to the upstream's hostname.   │
│   Emits another {readable, writable} of decrypted app data.│
│   For REALITY, additionally:                                │
│     - registers onKeyPairGenerated to capture X25519 priv  │
│     - registers onClientHelloPack to seal session_id       │
│     - registers onRecvCertificateVerify to bypass chain    │
└─┬──────────────────────────────────────────────────────────┘
  │  HTTP/1.1 plaintext
  ▼
┌────────────────────────────────────────────────────────────┐
│ runHttp1Stream                                             │
│   Hand-rolled HTTP/1.1: status line + headers parse,       │
│   content-length + chunked + until-EOF body framing.      │
│   Returns Web Response. SSE/streaming bodies pass through. │
└────────────────────────────────────────────────────────────┘
```

## Performance — wall-clock latency from local mac → Worker → JP server (median of 8)

| Target | native-direct (workerd TLS) | userspace-direct (reclaim) | overhead |
|---|---|---|---|
| /echo (~300 B body) | 488 ms | 497 ms | +1.8 % |
| /large (5 MiB body) | 925 ms | 1198 ms | +29.5 % |

Most of the 5 MiB overhead is JS-layer AEAD per record (16-byte tag + state
update for every <16 KiB payload chunk). For LLM gateway traffic — small
JSON requests + streaming SSE — the small-body number dominates and the
overhead is negligible. Heavy-body upstreams (image generation,
embeddings batches) take ~30 % longer.

A `rustls-wasm` integration would likely close most of the 30 % gap on
large bodies (the AEAD inner loop in Rust → WASM is much faster than
@noble/ciphers' pure-JS chacha20). The trade-off is a 300-400 KiB gzip
WASM blob, longer startup time, and a Rust toolchain dependency. Worth
re-evaluating once we ship and have real production cost data.

## Reproducibility

Every artifact, log, and patch is in `experiments/proxy-dial/`:

- `STATUS.md` — original plan, ports allocation, cleanup checklist
- `notes/01-acme-issue.log` — Let's Encrypt provisioning for `23.145.36.136.sslip.io`
- `notes/02-secrets.log` — REALITY keypair, UUID, passwords (test-only)
- `notes/03-singbox-up.log` — sing-box config push & restart
- `notes/04-nginx-upstream-up.log` — nginx + Python upstream service
- `notes/05-FINDING-startTls-edge-bug.md` — the workerd #2712 trace
- `notes/05-tls-failure-trace.txt` — raw tcpdump output
- `notes/06-matrix-results.txt` — first 13-runner pass
- `notes/07-success-summary.md` — interim summary at the 13-runner mark
- `notes/08-final-matrix.txt` — final 14-runner matrix including REALITY
- `notes/09-tls-bench.txt` — wall-time benchmark
- `artifacts/sing-box-config.json` — server config used during testing
- `artifacts/nginx-proxy-test.conf` — upstream nginx site
- `artifacts/upstream-test-server.py` — Python deterministic upstream
- `artifacts/upstream-test.service` — systemd unit
- `artifacts/sing-box-local-client.json` — local sing-box client config (server-side smoke)
- `test-worker/` — the Worker harness + reclaim-tls patches + ProxyRunner impls
- `scripts/test-matrix.sh` — full-matrix curl driver
- `scripts/bench-tls.sh` — wall-time benchmark driver

## What was deployed during testing

Two test servers (per user instruction):

- **23.145.36.136 (neburst-jp, Debian 13)** — primary test stack
  - Existing services preserved: rathole on 23333, sing-box's pre-existing
    SS-2022 / Hysteria2 / AnyTLS inbounds on 56001-56003.
  - Added inbounds 56010-56018 covering: HTTP CONNECT plain (mixed),
    SOCKS5 with auth, Trojan over TLS, VLESS-TCP-TLS, VLESS-WS-TLS,
    Shadowsocks AEAD-2018 chacha20, VLESS-REALITY, HTTP CONNECT over TLS,
    Shadowsocks AEAD-2018 aes-256-gcm.
  - Real Let's Encrypt cert for `23.145.36.136.sslip.io` via acme.sh
    standalone HTTP-01 (cert at `/etc/proxy-test/certs/`).
  - nginx site at `/etc/nginx/sites-available/proxy-test` fronting an
    upstream-test Python server on 127.0.0.1:8090, exposing
    `/echo`, `/sse`, `/chunked`, `/slow`, `/abort`, `/sleep-then-200`,
    `/large-5mb.bin`.

- **154.31.113.57 (sg, Ubuntu 22.04)** — untouched. (Has user's `ceerrep.com`
  site running; we deliberately avoided modifying anything here.)

The original sing-box config is backed up at
`/etc/sing-box/config.json.bak.20260606-083217` on JP. Cleanup script
restores it.

## Cleanup

See `scripts/cleanup.sh` (run from local mac with SSH access). Idempotent.
