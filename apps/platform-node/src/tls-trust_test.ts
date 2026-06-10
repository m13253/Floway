import { describe, expect, it } from 'vitest';

import { nodeGetRuntimeRootCAs } from './tls-trust.ts';

describe('nodeGetRuntimeRootCAs', () => {
  it('returns Node\'s bundled root certificate PEMs', () => {
    const cas = nodeGetRuntimeRootCAs();
    expect(cas).not.toBeNull();
    expect(Array.isArray(cas)).toBe(true);
    expect(cas!.length).toBeGreaterThan(50);
    expect(cas![0]).toContain('-----BEGIN CERTIFICATE-----');
    expect(cas![0]).toContain('-----END CERTIFICATE-----');
  });
});
