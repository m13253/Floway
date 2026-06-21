// Per-channel publish/subscribe with content-agnostic payload. Implementations
// live in the platform-target apps (Durable-Object-backed on Cloudflare,
// EventTarget-backed on Node); each takes a codec at construction time so the
// channel transport stays unaware of the payload shape. Callers compose this
// with a typed wrapper that knows the payload (see packages/gateway/src/dump/
// for one such wrapper).

export interface Codec<T> {
  encode(value: T): string;
  decode(payload: string): T;
}

export interface ChannelBroker<T> {
  publish(channelId: string, payload: T): Promise<void>;
  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T>;
  closeChannel(channelId: string, reason: string): Promise<void>;
}
