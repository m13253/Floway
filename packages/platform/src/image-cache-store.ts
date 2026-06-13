export interface ImageCacheStore {
  // Sliding-TTL read: a hit refreshes the entry's expiry to `now + refreshTtlMs`
  // before returning the bytes, so frequently-read images stay cached. The
  // refresh is awaited inline so semantics are deterministic on Cloudflare
  // Workers, which would otherwise drop a fire-and-forget write without an
  // explicit `waitUntil`.
  get(key: string, refreshTtlMs: number): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array, ttlMs: number): Promise<void>;
  // Drop entries whose `expires_at <= now`. Runtimes whose underlying store
  // already evicts on TTL (e.g. Cloudflare KV via `expirationTtl`) implement
  // this as a no-op; runtimes backed by a plain table (Node sqlite) need an
  // explicit DELETE so expired rows do not accumulate.
  sweepExpired(now: number): Promise<void>;
}

let imageCacheStore: ImageCacheStore | null = null;

export const initImageCacheStore = (store: ImageCacheStore): void => {
  imageCacheStore = store;
};

export const getImageCacheStore = (): ImageCacheStore => {
  if (!imageCacheStore) throw new Error('ImageCacheStore not initialized - call initImageCacheStore() first');
  return imageCacheStore;
};
