# Perf-tuning journey — summary

Starting point (reclaim default cipher = chacha20-poly1305 via @noble pure JS):
- `userspace-direct/upload-5mb` median: **738 ms CPU**

After cipher-list filter to AES-only (forces Web Crypto AES-GCM, AES-NI hw-accel):
- `userspace-direct/upload-5mb`: **199 ms CPU**

After local-bench infrastructure and V8 inspector profiling (`scripts/profile.mjs`):
- Top function: `toHexStringWithWhitespace` at **76% of CPU time**.
- Found: reclaim's `writeEncryptedPacket` calls
  `logger.trace({ ...opts, data: toHexStringWithWhitespace(opts.data) }, '…')`.
  JS evaluates the args eagerly; the trace level filter happens too late.
  For a 5 MiB upload the function builds 320 × 16 KiB hex strings — pure
  string concatenation that the trace log immediately discards.

After patching `toHexStringWithWhitespace` to return `<NN bytes>`:
- `userspace-direct/upload-5mb`: **30 ms CPU** (24× over starting point, 2× over native baseline)

Other things tried that did NOT help:
- Replacing reclaim's Web Crypto AES with `@noble/ciphers` sync GCM: 199→301 ms (slower; pure JS AES doesn't beat AES-NI even with promise overhead)
- rustls-wasm: 30→36 ms (close but not better; +240 KB gzip bundle)
- rustls-wasm with `+simd128` + `wasm-opt -O3`: no measurable change
- Body chunk size 64 KiB → single-write or 16 KiB: noisy, no consistent win

Final: **reclaim with toHex stub + AES cipher suites forced**. 30 ms upload-5mb,
no WASM dependency, no rustls toolchain in the build.

## Final-final matrix (30 iter local, ms wall total)

|                | reclaim (post-fix) | rustls-chacha (vendored, unused) | native |
|---|---|---|---|
| download 500k  |  9 | 19 |  ~1 (workerd) |
| download 5 MiB | 32 | 82 | ~5 |
| upload 500k    | 12 | 19 |  ~1 |
| upload 5 MiB   | **30** | 36 | ~10 |

native = `secureTransport: 'on'` socket; lower bound, but not reachable for
proxy-dial paths because workerd's prod-edge `startTls()` is broken (#2712)
and TLS-in-TLS is rejected.

## Cost model (per million 5 MiB upload requests, Workers Standard)

|  | CPU s/M | $/M @ $0.02/M-CPU-ms |
|---|---|---|
| native (theoretical) | ~10 | $0.20 |
| reclaim post-fix | ~30 | $0.60 |
| reclaim before fix | ~750 | $15.00 |

For the prod copilot worker (711 K req/mo, 31 222 CPU-s baseline), even at
100% proxy-dial adoption with the post-fix path we'd add ~21 K CPU-s/mo →
+$0.42/mo. Negligible.
