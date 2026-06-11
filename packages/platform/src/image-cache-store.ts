export interface ImageCacheStore {
  get(key: string): Promise<Uint8Array | null>;
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
