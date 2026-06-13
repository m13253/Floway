import type { ImageCacheStore } from '@floway-dev/platform';

// Minimal shape of the Cloudflare KV binding we depend on. Hand-typed so the
// runtime contract does not pull in the full @cloudflare/workers-types
// surface.
export interface KvNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { expirationTtl?: number }): Promise<void>;
}

// CF KV requires `expirationTtl` in seconds with a 60-second minimum
// (https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys).
// Image-cache callers always pass a TTL in the days range, so the floor is
// academic, but rounding up keeps very-short TTLs valid in case a caller ever
// asks for one.
const KV_MIN_TTL_SECONDS = 60;

const ttlSeconds = (ttlMs: number): number => Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlMs / 1000));

export class KvImageCache implements ImageCacheStore {
  constructor(private readonly kv: KvNamespace) {}

  async get(key: string, refreshTtlMs: number): Promise<Uint8Array | null> {
    const buf = await this.kv.get(key, 'arrayBuffer');
    if (!buf) return null;
    // Refresh expiry by re-writing with a fresh `expirationTtl`. Awaited so
    // semantics are deterministic on Workers, which would drop a
    // fire-and-forget write without an explicit `waitUntil`.
    await this.kv.put(key, buf, { expirationTtl: ttlSeconds(refreshTtlMs) });
    return new Uint8Array(buf);
  }

  async put(key: string, value: Uint8Array, ttlMs: number): Promise<void> {
    await this.kv.put(key, value, { expirationTtl: ttlSeconds(ttlMs) });
  }

  // KV evicts via the per-key `expirationTtl` set at write time, so the
  // central scheduled-maintenance hook has nothing to do here.
  sweepExpired(_now: number): Promise<void> {
    return Promise.resolve();
  }
}
