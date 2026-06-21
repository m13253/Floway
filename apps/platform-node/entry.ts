import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  initResponsesWebSocketUpgradeResolver,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional } from '@floway-dev/platform';

// Node has no executionCtx.waitUntil; fire-and-forget with a logged
// rejection so background failures aren't silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const { db } = bootstrapNodePlatform();
const port = Number(getEnvOptional('PORT', '8788'));

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

await applyMigrations(db);
initRepo(new SqlRepo(db));

// Run once at startup (so processes that restart faster than the interval
// still sweep) and then hourly. unref() lets SIGINT exit; failures are
// logged so one bad sweep doesn't kill future ones. The 30s delay keeps
// the very first request after boot from racing the sweep.
const STARTUP_DELAY_MS = 30 * 1000;
const sweep = (): void => {
  runScheduledMaintenance().catch(err => {
    console.error('[scheduled-maintenance] sweep failed:', err);
  });
};
setTimeout(sweep, STARTUP_DELAY_MS).unref();
setInterval(sweep, SCHEDULED_INTERVAL_MS).unref();

serve({
  fetch: app.fetch,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => {
  console.log(`floway listening on http://localhost:${info.port}`);
});
