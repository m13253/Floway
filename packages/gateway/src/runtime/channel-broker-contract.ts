// Per-channel publish/subscribe with content-agnostic payload. The codec
// is supplied at construction so the channel transport stays unaware of
// the payload shape; callers compose this with a typed wrapper that knows
// the payload.

export interface Codec<T> {
  encode(value: T): string;
  decode(payload: string): T;
}

export interface ChannelBroker<T> {
  publish(channelId: string, payload: T): Promise<void>;
  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T>;
  closeChannel(channelId: string, reason: string): Promise<void>;
}
