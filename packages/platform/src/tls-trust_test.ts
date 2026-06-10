import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRuntimeRootCAs,
  initRuntimeRootCAs,
  resetRuntimeRootCAsForTesting,
} from './tls-trust.ts';

describe('RuntimeRootCAs singleton', () => {
  beforeEach(() => {
    resetRuntimeRootCAsForTesting();
  });

  it('throws when used before init', () => {
    expect(() => getRuntimeRootCAs()).toThrow('RuntimeRootCAs not initialized');
  });

  it('returns the registered impl after init', () => {
    const fn = (): readonly string[] | null => null;
    initRuntimeRootCAs(fn);
    expect(getRuntimeRootCAs()).toBe(fn);
  });

  it('passes the impl through unchanged for non-null returns', () => {
    const pems = ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'];
    initRuntimeRootCAs(() => pems);
    expect(getRuntimeRootCAs()()).toBe(pems);
  });
});
