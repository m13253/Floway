import { serve } from '@hono/node-server';

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/proxy';

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

const dbPath = process.env.FLOWAY_DB_PATH ?? './data/floway.db';
const filesDir = process.env.FLOWAY_FILES_DIR ?? './data/files';
const port = Number(process.env.PORT ?? 8788);

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

const { db } = bootstrapNodePlatform({ dbPath, filesDir });
await applyMigrations(db);
initRepo(new SqlRepo(db));

// CF triggers scheduled maintenance via cron; on Node we run the same job on
// a wall-clock interval. unref() lets the process exit cleanly on SIGINT
// even though the timer is still pending.
setInterval(
  () => {
    runScheduledMaintenance().catch(err => console.error('[scheduled]', err));
  },
  SCHEDULED_INTERVAL_MS,
).unref();

serve({ fetch: app.fetch, port }, info => {
  console.log(`floway listening on http://localhost:${info.port}`);
});
