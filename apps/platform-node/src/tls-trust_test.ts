import tls from 'node:tls';
import { describe, expect, it } from 'vitest';

import { nodeRuntimeRootCAs } from './tls-trust.ts';

describe('nodeRuntimeRootCAs', () => {
  it('exposes a PEM-encoded root certificate list', () => {
    expect(Array.isArray(nodeRuntimeRootCAs)).toBe(true);
    expect(nodeRuntimeRootCAs.length).toBeGreaterThan(50);
    expect(nodeRuntimeRootCAs[0]).toContain('-----BEGIN CERTIFICATE-----');
    expect(nodeRuntimeRootCAs[0]).toContain('-----END CERTIFICATE-----');
  });

  it('is a superset of the bundled Mozilla list', () => {
    const set = new Set(nodeRuntimeRootCAs);
    for (const pem of tls.getCACertificates('bundled')) expect(set.has(pem)).toBe(true);
  });

  it('deduplicates roots present in multiple sources', () => {
    expect(new Set(nodeRuntimeRootCAs).size).toBe(nodeRuntimeRootCAs.length);
  });
});
