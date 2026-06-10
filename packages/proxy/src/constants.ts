// Tunable constants exposed to consumers that don't want to pull the dial
// runtime. Values live here rather than on dialer.ts so importing a
// constant doesn't drag the protocol runners + userspace TLS stack into
// the consumer's bundle.

// Hard ceiling on the time the dial layer is allowed to spend before
// callers should give up on this entry. Counts TCP connect + every
// handshake leg, but not the upstream response — once the request bytes
// have been written we expect normal response streaming. 10s keeps a
// black-holed entry from stalling the call: a healthy outer-TCP +
// outer-TLS + proxy-handshake + inner-TLS round-trip finishes well under
// that even on latency-bound links. Override per call by passing
// options.dialTimeoutMs to runProxiedRequest.
export const DEFAULT_DIAL_DEADLINE_MS = 10_000;
