// Resolve a codex models catalog for a given codex client version.
//
// Strategy:
//   1. Parse `codex_exec/<version>` from the request user-agent
//   2. In-memory cache by version (catalog of a released codex tag is immutable)
//   3. On cache miss, fetch the matching tag from
//      `https://raw.githubusercontent.com/openai/codex/rust-v<version>/codex-rs/models-manager/models.json`
//   4. Fall back to the bundled snapshot on any failure: missing/unparseable
//      user-agent, GitHub 404 (unreleased version), network error
//
// The bundled snapshot is a frozen copy from openai/codex (Apache-2.0,
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json).
// It guarantees the endpoint stays useful for cold starts, network-restricted
// operators, and clients running unreleased builds.

import bundledCatalog from './catalog/bundled.json' with { type: 'json' };
import type { CodexCatalog } from './patches.ts';

const VERSION_FROM_USER_AGENT = /codex_exec\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;

const inMemoryCache = new Map<string, CodexCatalog>();

const bundled = bundledCatalog as unknown as CodexCatalog;

const parseCodexVersion = (userAgent: string | undefined): string | null =>
  userAgent?.match(VERSION_FROM_USER_AGENT)?.[1] ?? null;

const fetchCodexCatalog = async (version: string): Promise<CodexCatalog | null> => {
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return (await resp.json()) as CodexCatalog;
};

export const resolveCodexCatalog = async (userAgent: string | undefined): Promise<CodexCatalog> => {
  const version = parseCodexVersion(userAgent);
  if (version === null) return bundled;

  const cached = inMemoryCache.get(version);
  if (cached !== undefined) return cached;

  const fetched = await fetchCodexCatalog(version).catch(() => null);
  const resolved = fetched ?? bundled;
  inMemoryCache.set(version, resolved);
  return resolved;
};
