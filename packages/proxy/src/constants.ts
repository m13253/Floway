// Tunable constants exposed to consumers that don't want to pull the dial
// runtime (e.g. the dashboard, which only renders these as UI defaults).
// Values live here rather than on dialer.ts so a SPA import of the
// constant doesn't drag the protocol runners + userspace TLS stack into
// the browser bundle.

// Hard ceiling on the time the dial layer is allowed to spend before the
// fallback chain moves on. Counts TCP connect + every handshake leg, but
// not the upstream response — once the request bytes have been written we
// expect normal response streaming. Reality / VLESS-WS / Trojan over a
// real-world latency-bound link can take 8-15s for outer-TCP + outer-TLS
// + proxy-handshake + inner-TLS combined; 30s leaves ~2× headroom on top
// of that without letting a black-holed proxy entry stall the call for a
// minute+. Operators can override per-proxy via the `dial_timeout_seconds`
// column; runProxiedRequest's options.dialTimeoutMs takes the override.
export const DEFAULT_DIAL_DEADLINE_MS = 30_000;
