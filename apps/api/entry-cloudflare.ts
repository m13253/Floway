import type { ExecutionContext } from 'hono';

import { app } from './src/app.ts';
import { createCloudflareImageProcessor, type ImagesBinding } from './src/image/cloudflare.ts';
import { initImageProcessor } from './src/image/index.ts';
import { type D1Database, D1Repo } from './src/repo/d1.ts';
import { initRepo } from './src/repo/index.ts';
import { initEnv } from './src/runtime/env.ts';

// Raw Cloudflare KV binding shape (its `put` takes an options object). We adapt
// it to the image cache's contract, which requires an explicit positional TTL.
interface KvNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  DB: D1Database;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  [key: string]: unknown;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const kv = env.KV;
    initEnv(n => (env[n] as string) ?? '');
    initRepo(new D1Repo(env.DB));
    initImageProcessor(
      createCloudflareImageProcessor(env.IMAGES, {
        get: (key, type) => kv.get(key, type),
        put: (key, value, expirationTtl) => kv.put(key, value, { expirationTtl }),
      }),
    );
    return app.fetch(req, env, ctx);
  },
};
