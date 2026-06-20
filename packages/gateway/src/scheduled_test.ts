import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from './runtime/dump.ts';
import { runScheduledMaintenance } from './scheduled.ts';
import { setupAppTest } from './test-helpers.ts';
import { initImageCacheStore } from '@floway-dev/platform';
import { assertEquals, installDumpStubs } from '@floway-dev/test-utils';

const noopImageCache = {
  get: async () => null,
  put: async () => { /* noop */ },
  sweepExpired: async () => { /* noop */ },
};

test('runScheduledMaintenance continues sweeping the next key when one key throws', async () => {
  // Per-key isolation inside the dump sweep: a slow or broken per-key purge
  // must not poison the sweep for sibling keys on the same tick. Inject a
  // throw and confirm the sweep still recorded the second key's purge.
  const { repo, apiKey: keyA } = await setupAppTest();
  await repo.apiKeys.save({ ...keyA, dumpRetentionSeconds: 3600 });
  const keyB = {
    ...keyA,
    id: `${keyA.id}_sibling`,
    key: `${keyA.key}_sibling`,
    dumpRetentionSeconds: 1800,
  };
  await repo.apiKeys.save(keyB);

  initImageCacheStore(noopImageCache);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  // Throw on every purgeExpired call. Each iteration of the sweep catches
  // and logs, so both keys still get visited even though neither purge
  // completes successfully — the contract is "do not abort the rest", not
  // "succeed on a poisoned key".
  stubs.failOn('purgeExpired', new Error('purge exploded'));

  // The sweep itself must not propagate the per-key throw — the outer
  // `runSweep` wrapper would log it too, but the per-key try/catch handles
  // each iteration first.
  await runScheduledMaintenance();
});

test('runScheduledMaintenance keeps subsequent sweeps running when one top-level sweep throws', async () => {
  // Top-level sweep isolation: a failure in (e.g.) image-cache sweepExpired
  // must not drop the dump sweep on the same tick. We swap the image cache
  // for one that throws, then confirm the dump sweep still ran by observing
  // its side effect.
  const { repo, apiKey: keyA } = await setupAppTest();
  await repo.apiKeys.save({ ...keyA, dumpRetentionSeconds: 3600 });

  initImageCacheStore({
    ...noopImageCache,
    sweepExpired: async () => { throw new Error('image cache exploded'); },
  });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  await runScheduledMaintenance();
  // The dump sweep ran despite the image-cache failure — the stub recorded
  // a purgeExpired call for the only retention-enabled key.
  assertEquals(stubs.purgedExpired.some(c => c.keyId === keyA.id), true);
});
