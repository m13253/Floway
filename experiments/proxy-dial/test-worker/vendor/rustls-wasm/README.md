# rustls-wasm (vendored)

Vendored build of [`MercuryWorkshop/rustls-wasm`][upstream] producing a
self-contained ESM bundle that ships an embedded base64 WASM module
suitable for Cloudflare Workers (no atomics, no `SharedArrayBuffer`, no
threads).

[upstream]: https://github.com/MercuryWorkshop/rustls-wasm

The exported function is:

```ts
import init, { connect_tls } from "./dist/rustls-bundled.js";

await init();                                // instantiates the embedded WASM
const { read, write } = await connect_tls(   // both args may be byte streams
  rawSocketReadable,                         //   - BYOB-capable ReadableStream OR
  rawSocketWritable,                         //   - regular ReadableStream of
  "example.com",                             //     Uint8Array | ArrayBuffer | string
);
```

`connect_tls` opens a TLS client connection over the supplied byte streams
(typically the `readable`/`writable` halves of a `connect()` socket) and
returns a fresh `{ read, write }` pair carrying the decrypted plaintext.

## Versions in this bundle

| Component        | Version                                    |
| ---------------- | ------------------------------------------ |
| upstream commit  | `248dac2764a72e8141339a927690d90d130fc9f2` |
| `rustls`         | 0.23.12                                    |
| `futures-rustls` | 0.26.0 (features: `tls12`, `ring`)         |
| `rustls-webpki`  | 0.102.6                                    |
| `rustls-pki-types` | 1.7.0                                    |
| `webpki-roots`   | 0.26.3                                     |
| `ring`           | 0.17.8 (`wasm32_unknown_unknown_js`)       |
| `wasm-bindgen`   | 0.2.92                                     |

## Build flags (deviates from upstream `build.sh`)

Upstream's `build.sh` enables `+atomics` in `RUSTFLAGS`, which produces a
multi-threaded WASM binary requiring `SharedArrayBuffer`. Cloudflare
Workers do not expose `SharedArrayBuffer`, so we drop `+atomics` and keep
only `+bulk-memory`. The current nightly also rejects the
`panic_immediate_abort` build-std feature (it is now a real panic
strategy), so we pass it through `RUSTFLAGS` instead.

```bash
RUSTFLAGS='-C target-feature=+bulk-memory -Zlocation-detail=none \
           -Zunstable-options -Cpanic=immediate-abort' \
  cargo build --target wasm32-unknown-unknown \
              -Z build-std=panic_abort,std \
              -Z build-std-features=optimize_for_size \
              --release
wasm-bindgen --target web --out-dir out/ \
  target/wasm32-unknown-unknown/release/rustls_wasm.wasm
wasm-opt -Oz --vacuum --dce --enable-bulk-memory \
  out/rustls_wasm_bg.wasm -o out/rustls_wasm_bg.opt.wasm
```

The output WASM declares only these target features (verified via the
`target_features` custom section): `mutable-globals`,
`nontrapping-fptoint`, `bulk-memory`, `sign-ext`, `reference-types`,
`multivalue`. No `atomics`; no shared memory. WASM imports come from a
single `wbg` namespace supplied by the wasm-bindgen JS glue.

The bundling step inlines the optimised WASM into the wasm-bindgen JS
output as a base64 `data:application/wasm;...` URL so the artifact is a
single self-contained ESM module. Note: this path differs from upstream's
`build.sh` regex (which assumes the `__wbg_init(input, maybe_memory)`
two-arg signature emitted only in multi-threaded builds); the
single-threaded build emits `__wbg_init(input)` and is patched
accordingly.

## Toolchain

- macOS-side wasm-compatible clang via `brew install llvm`. `ring`'s
  build script needs a clang that targets `wasm32-unknown-unknown`;
  Apple's bundled clang does not. Set `CC_wasm32_unknown_unknown` and
  `AR_wasm32_unknown_unknown` to the keg-only LLVM binaries before
  invoking cargo.
- Rust nightly with `rust-src` and the `wasm32-unknown-unknown` target.
- `wasm-bindgen-cli` pinned to 0.2.92 to match the dependency in
  `source/Cargo.toml` (newer CLIs refuse to process the metadata schema
  emitted by 0.2.92 procmacros).
- `wasm-opt` (any recent version; 116 used here).

## Files

- `dist/rustls-bundled.js` — self-contained ESM with embedded base64
  WASM. ~683 KiB on disk; ~293 KiB gzip.
- `dist/rustls.d.ts`, `dist/rustls-bundled.d.ts` — TypeScript types for
  the bundled module. The default export is `() => Promise<void>` (no
  init argument needed because the WASM is inlined).
- `source/` — upstream clone with our build artifacts under
  `source/pkg/`. Only `dist/` is the stable consumption surface.

## Rebuilding

```bash
cd source
export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar

RUSTFLAGS='-C target-feature=+bulk-memory -Zlocation-detail=none \
           -Zunstable-options -Cpanic=immediate-abort' \
  cargo build --target wasm32-unknown-unknown \
              -Z build-std=panic_abort,std \
              -Z build-std-features=optimize_for_size \
              --release

mkdir -p out pkg
wasm-bindgen --target web --out-dir out/ \
  target/wasm32-unknown-unknown/release/rustls_wasm.wasm
mv out/rustls_wasm_bg.wasm out/rustls_wasm_unoptimized.wasm
wasm-opt -Oz --vacuum --dce --enable-bulk-memory \
  out/rustls_wasm_unoptimized.wasm -o out/rustls_wasm_bg.wasm

# Inline base64 WASM into a single-file ESM (see ../scripts/bundle.mjs
# in any future automation; this README documents the manual recipe).
```

After rebuilding, copy `source/pkg/rustls-bundled.js` and the matching
`.d.ts` into `dist/`.

---

## Status: NOT used in production code path

After perf-tuning iteration we picked patched `@reclaimprotocol/tls` instead.
See `experiments/proxy-dial/notes/16-perf-journey-summary.md`.

Brief: profiling reclaim revealed `toHexStringWithWhitespace` was eating 76%
of CPU per upload via eager evaluation of `logger.trace(...)` arguments;
stubbing it dropped 5 MiB upload from 199 ms to 30 ms. With that bug fixed
reclaim became *faster than* this rustls path (30 ms vs 36 ms) without the
240 KB gzip WASM payload. Patches/lib.rs modifications listed below were
also rebuilt with these flags:

```rust
// jsval_to_vec — accept Uint8Array (workerd socket.readable yields views)
} else if let Some(arr) = val.dyn_ref::<Uint8Array>() {
    Ok(arr.to_vec())

// connect_tls — force ChaCha20-Poly1305 only (WASM has no AES-NI)
let provider = futures_rustls::rustls::crypto::CryptoProvider {
    cipher_suites: vec![
        futures_rustls::rustls::crypto::ring::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
        futures_rustls::rustls::crypto::ring::cipher_suite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        futures_rustls::rustls::crypto::ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
    ],
    ..futures_rustls::rustls::crypto::ring::default_provider()
};
```

The `rustls-bundled.js` here also has two post-build patches applied:

1. `WebAssembly.instantiate(module, imports)` → `new WebAssembly.Instance(module, imports)`
   (Workers production sandbox forbids the former)
2. The base64 data-URL embed inside `__wbg_init` was stripped so the WASM
   is supplied via a static `import wasmModule from './rustls.wasm'`

Kept on disk because rebuilding requires a non-trivial Rust toolchain and the
artifacts may still be useful if reclaim ever hits a corner case.
