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
// Compressed image entries live for ~30 days so the floor is academic, but
// rounding up still keeps very-short TTLs valid in case a caller ever asks
// for one.
const KV_MIN_TTL_SECONDS = 60;

export class KvImageCache implements ImageCacheStore {
  constructor(private readonly kv: KvNamespace) {}

  async get(key: string): Promise<Uint8Array | null> {
    const buf = await this.kv.get(key, 'arrayBuffer');
    return buf ? new Uint8Array(buf) : null;
  }

  async put(key: string, value: Uint8Array, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlMs / 1000));
    await this.kv.put(key, value, { expirationTtl: ttlSeconds });
  }
}
