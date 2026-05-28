import type { ExecutionContext } from 'hono';

import { app } from './src/app.ts';
import { type D1Database, D1Repo } from './src/repo/d1.ts';
import { getRepo, initRepo } from './src/repo/index.ts';
import { initEnv } from './src/runtime/env.ts';
import { initFileProvider } from './src/runtime/file-provider.ts';
import { R2FileProvider, type R2BucketLike } from './src/runtime/r2-file-provider.ts';

const RESPONSES_ITEM_PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const startOfUtcHour = (timestamp: number): number => Math.floor(timestamp / HOUR_MS) * HOUR_MS;

interface Env {
  DB: D1Database;
  FILES: R2BucketLike;
  [key: string]: unknown;
}

const initRuntime = (env: Env): void => {
  initEnv(n => (env[n] as string) ?? '');
  initRepo(new D1Repo(env.DB));
  initFileProvider(new R2FileProvider(env.FILES));
};

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    initRuntime(env);
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    initRuntime(env);
    const now = startOfUtcHour(Date.now());
    ctx.waitUntil((async () => {
      await getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS);
      await getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
    })());
  },
};
