import { test } from 'vitest';

import { sweepExpiredResponsesItemPayloadFiles } from './responses-payload.ts';
import { initFileProvider, MemoryFileProvider } from '../runtime/file-provider.ts';
import { assertEquals } from '../test-assert.ts';

test('sweepExpiredResponsesItemPayloadFiles drops the hour bucket that just elapsed and leaves later buckets intact', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);

  await files.put('responses-items/v1/expires/2026/06/27/10/scope/a.json', new Uint8Array([1]));
  await files.put('responses-items/v1/expires/2026/06/27/10/scope/b.json', new Uint8Array([2]));
  await files.put('responses-items/v1/expires/2026/06/27/11/scope/c.json', new Uint8Array([3]));
  await files.put('responses-items/v1/expires/2026/06/27/12/scope/d.json', new Uint8Array([4]));

  // now=2026-06-27T11:30 — the just-elapsed hour bucket is 10.
  await sweepExpiredResponsesItemPayloadFiles(Date.UTC(2026, 5, 27, 11, 30));

  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/10/scope/a.json'), null);
  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/10/scope/b.json'), null);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/11/scope/c.json'))!], [3]);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/12/scope/d.json'))!], [4]);
});
