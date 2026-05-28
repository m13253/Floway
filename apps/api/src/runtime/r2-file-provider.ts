import type { FileProvider } from './file-provider.ts';

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

export class R2FileProvider implements FileProvider {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.bucket.put(key, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
