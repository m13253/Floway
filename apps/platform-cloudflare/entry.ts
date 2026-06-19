import type { ExecutionContext } from 'hono';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from './src/bootstrap.ts';
import { createCloudflareDumpBroker } from './src/dump/broker.ts';
import { KeyDumpDO } from './src/dump/key-dump-do.ts';
import { createCloudflareDumpStore } from './src/dump/store.ts';
import {
  app,
  getRepo,
  initBackgroundSchedulerResolver,
  initDumpBroker,
  initDumpStore,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

initBackgroundSchedulerResolver(c => promise => c.executionCtx.waitUntil(promise));

export { KeyDumpDO };

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    initDumpStore(createCloudflareDumpStore(env.KEY_DUMP_DO, async keyId => {
      const key = await getRepo().apiKeys.getById(keyId);
      return key?.dumpRetentionSeconds ?? null;
    }));
    initDumpBroker(createCloudflareDumpBroker(env.KEY_DUMP_DO));
    return app.fetch(req, env, ctx);
  },
  // Retention sweep is per-DO alarm (see KeyDumpDO.alarm), so the cron
  // handler does not iterate keys to purge dumps.
  scheduled(_controller: unknown, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    ctx.waitUntil(runScheduledMaintenance());
  },
};
