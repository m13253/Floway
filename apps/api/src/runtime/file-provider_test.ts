import { test } from 'vitest';

import { getFileProvider, initFileProvider, MemoryFileProvider } from './file-provider.ts';
import { assertEquals } from '../test-assert.ts';

test('MemoryFileProvider clones at the provider boundary', async () => {
  const provider = new MemoryFileProvider();
  const body = new Uint8Array([1, 2, 3]);

  await provider.put('k', body);
  body[0] = 9;

  const first = await provider.get('k');
  assertEquals(first ? [...first] : null, [1, 2, 3]);
  first![1] = 8;

  assertEquals([...(await provider.get('k'))!], [1, 2, 3]);
});

test('runtime exposes one initialized FileProvider instance', async () => {
  const provider = new MemoryFileProvider();
  initFileProvider(provider);

  await getFileProvider().put('k', new Uint8Array([4]));
  assertEquals([...(await provider.get('k'))!], [4]);
});
