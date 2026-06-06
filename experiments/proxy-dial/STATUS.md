# Proxy Dial Experiments — Status

Started: 2026-06-06.

## Servers in scope (user-provided)

### 23.145.36.136 — neburst-jp, Debian 13

Currently running:
- `sing-box` (systemd unit) listening on:
  - 56001 — Shadowsocks 2022 `2022-blake3-aes-256-gcm`, password
    `Pgevx6VbhdOmFEK7jeJYe83goa66T0HHQFfIrLtJuDo=`
  - 56002 — Hysteria2 (UDP, useless for Workers since no UDP egress)
  - 56003 — AnyTLS (sing-box-specific, not a generally deployed protocol)
- `rathole` on 23333 (unrelated tunnel — do not touch).
- sing-box uses a self-signed `example.com` cert at `/etc/sing-box/cert.pem`.
- No Let's Encrypt cert installed. Port 80 free.
- Hostname has no DNS A record.

### 154.31.113.57 — DMIT-sgHFLkiIEO, Ubuntu 22.04

Currently running:
- nginx 80/443 — fronts `ceerrep.com` (user's website, MUST NOT disrupt) and a default site.
- Multiple `ss-server` (libev) instances, one of which is `rc4-md5` — too old to bother with;
  the project should never ship `rc4-md5` support, so out of scope.
- `ssserver` (Rust shadowsocks-rust) on 65504 — config `warp.json`, not inspected.
- supernode 8989 (n2n p2p, unrelated).
- Has Let's Encrypt certs for `ceerrep.com` and `runa.moe` in `/root/.acme.sh/`.

## Plan

Deploy a parallel proxy stack on **JP** so SG remains untouched:

1. Get a real Let's Encrypt cert for `23.145.36.136.sslip.io` (sslip.io resolves
   any IP into a real DNS name; LE issues against it via HTTP-01). Port 80 is free
   on JP.
2. Install `xray-core` (latest) — supports every protocol we need including REALITY.
3. Run `xray` as a separate systemd unit with its own config under
   `/etc/xray-test/` and ports `56010-56020`. Backup of any existing config
   is unnecessary because we run a fresh service.
4. Add a self-hosted upstream nginx on JP for SSE / chunked / large-body tests
   (no need to touch SG nginx).
5. Reuse the existing sing-box SS-2022 on 56001 since it's already correct.

## Ports allocation (JP)

| Port | Protocol | Notes |
|---|---|---|
| 56010 | HTTP CONNECT (plain HTTP, with Basic auth) | xray inbound `http` |
| 56011 | SOCKS5 (with user/pass auth) | xray inbound `socks` |
| 56012 | Trojan over TLS | xray inbound `trojan` + real LE cert |
| 56013 | VLESS over TCP+TLS | xray `vless` + tlsSettings |
| 56014 | VLESS over WS+TLS | xray `vless` + ws + tls |
| 56015 | Shadowsocks AEAD-2018 (chacha20-ietf-poly1305) | xray `shadowsocks` |
| 56016 | VLESS over REALITY | xray `vless` + reality |
| 56017 | HTTP CONNECT over TLS | xray `http` + tlsSettings |
| 56001 | Shadowsocks 2022 (existing) | reuse |
| 80    | nginx for ACME HTTP-01 + upstream test endpoints | dual-purpose |
| 443   | nginx for upstream test endpoints (SSE etc.) | port to be re-used after 80-cert provisioned |

## Upstream test endpoints

Public:
- `https://httpbin.org/get` — basic request
- `https://httpbin.org/stream/N` — chunked / streaming
- `https://postman-echo.com/get` — alternate echo
- `https://www.cloudflare.com/` — large HTML

Self-hosted on JP nginx (after cert is set up):
- `https://23.145.36.136.sslip.io/sse-test` — SSE endpoint with deterministic events
- `https://23.145.36.136.sslip.io/slow-body` — sleeps mid-stream, tests timeouts
- `https://23.145.36.136.sslip.io/large-body` — 5 MB random
- `https://23.145.36.136.sslip.io/abort-mid` — closes mid-response

## Cleanup checklist

- [ ] Stop & remove `xray-test` systemd unit (`systemctl disable --now xray-test; rm /etc/systemd/system/xray-test.service`)
- [ ] Remove `/etc/xray-test/` directory
- [ ] Remove `/usr/local/bin/xray` if I installed it
- [ ] Remove nginx site at `/etc/nginx/sites-enabled/proxy-test` and the matching available file
- [ ] Remove `/var/www/proxy-test/` content
- [ ] Revoke Let's Encrypt cert for `23.145.36.136.sslip.io` (`certbot revoke --cert-name 23.145.36.136.sslip.io && certbot delete --cert-name 23.145.36.136.sslip.io`)
- [ ] Restore any modified system file (none expected, but verify)
- [ ] Remove the temporary Cloudflare Worker (whatever name we give it)

## Worker harness

Plan:
- Build at `experiments/proxy-dial/test-worker/` as its own pnpm package.
- Vendor the `MercuryWorkshop/rustls-wasm` build for the inner-TLS case.
- Worker exposes one route per (proxy, upstream) combination plus a single
  generic route taking proxy URI in a query param for ad-hoc retests.
- Tests are scripted via `curl` from local machine against the deployed Worker.
