// Tunable constants exposed to consumers that don't want to pull the dial
// runtime (e.g. the dashboard, which only renders these as UI defaults).
// Values live here rather than on dialer.ts so a SPA import of the
// constant doesn't drag the protocol runners + userspace TLS stack into
// the browser bundle.

// Hard ceiling on the time the dial layer is allowed to spend before the
// fallback chain moves on. Counts TCP connect + every handshake leg, but
// not the upstream response — once the request bytes have been written we
// expect normal response streaming. 10s keeps a black-holed proxy entry
// from stalling the call: a healthy outer-TCP + outer-TLS + proxy-
// handshake + inner-TLS round-trip finishes well under that even on
// latency-bound links, and the fallback chain advances quickly when one
// hop is dead. Operators with a genuinely slow link can override per call
// by passing options.dialTimeoutMs to runProxiedRequest.
export const DEFAULT_DIAL_DEADLINE_MS = 10_000;
