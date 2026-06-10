import { describe, expect, it } from 'vitest';

import { cloudflareGetRuntimeRootCAs } from './tls-trust.ts';

describe('cloudflareGetRuntimeRootCAs', () => {
  it('returns null because workerd exposes no runtime trust store', () => {
    expect(cloudflareGetRuntimeRootCAs()).toBeNull();
  });
});
