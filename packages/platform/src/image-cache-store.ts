export interface ImageCacheStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array, ttlMs: number): Promise<void>;
}

let imageCacheStore: ImageCacheStore | null = null;

export const initImageCacheStore = (store: ImageCacheStore): void => {
  imageCacheStore = store;
};

export const getImageCacheStore = (): ImageCacheStore => {
  if (!imageCacheStore) throw new Error('ImageCacheStore not initialized - call initImageCacheStore() first');
  return imageCacheStore;
};
