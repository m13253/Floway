import type { Repo } from '../repo/types.ts';
import type { UpstreamFetch } from '@floway-dev/provider';
import { ProxyDialError, type ProxyConfig, type TargetSpec } from '@floway-dev/proxy';

export interface CreateUpstreamFetchInput {
  repo: Pick<Repo, 'proxyBackoffs' | 'proxies'>;
  upstreamId: string;
  fallbackList: string[];
  proxyById: Map<string, ProxyConfig>;
  // Per-request indirection so tests can mock the proxy library.
  runProxied: (config: ProxyConfig, target: TargetSpec) => Promise<Response>;
  // Per-request indirection for the 'direct' sentinel.
  runDirect: (url: string, init: RequestInit) => Promise<Response>;
}

// Two-pass dial strategy. First pass walks the fallback list skipping any
// entry whose (proxy, upstream) backoff row is still active, so a flaky
// proxy gets shed in steady state. If every entry was skipped or every
// non-skipped entry hit a ProxyDialError, the second pass walks the same
// list ignoring backoff state — that's how we both kick the recovery
// schedule and keep serving when literally every proxy is in cooldown.
//
// Body buffering is deferred until a non-`direct` proxy actually needs it;
// the direct-only fast path passes `init` straight to runtime `fetch`,
// which is how non-buffered shapes like FormData stay supported.
export const createUpstreamFetch = (input: CreateUpstreamFetchInput): UpstreamFetch => {
  const list = input.fallbackList.length > 0 ? input.fallbackList : ['direct'];
  return async (url, init) => {
    let target: TargetSpec | undefined;
    const targetForProxy = async (): Promise<TargetSpec> => {
      target ??= await buildTargetSpec(url, init);
      return target;
    };
    const errors: ProxyDialError[] = [];

    const active = await input.repo.proxyBackoffs.listForUpstream(input.upstreamId);
    const now = Math.floor(Date.now() / 1000);
    const skip = new Set(active.filter(b => b.expiresAt > now).map(b => b.proxyId));
    for (const id of list) {
      if (skip.has(id)) continue;
      const result = await tryOne(id, input, targetForProxy, url, init, errors);
      if (result) return result;
    }

    for (const id of list) {
      const result = await tryOne(id, input, targetForProxy, url, init, errors);
      if (result) return result;
    }

    // A single fallback entry that fails both passes still produces two
    // ProxyDialErrors in `errors`, but the upstream really only had one
    // dial path — surface that single error directly so callers don't see
    // a meaningless AggregateError wrapper.
    throw list.length === 1
      ? errors[errors.length - 1]!
      : new AggregateError(errors, 'all proxies failed at the dial layer');
  };
};

const tryOne = async (
  id: string,
  input: CreateUpstreamFetchInput,
  targetForProxy: () => Promise<TargetSpec>,
  url: string,
  init: RequestInit,
  errors: ProxyDialError[],
): Promise<Response | null> => {
  try {
    if (id === 'direct') {
      // Direct egress is the runtime's fetch — it never raises ProxyDialError,
      // so we don't touch the backoff table for this entry.
      return await input.runDirect(url, init);
    }
    const config = input.proxyById.get(id);
    if (!config) {
      throw new Error(`unknown proxy id in fallback list: ${id}`);
    }
    const response = await input.runProxied(config, await targetForProxy());
    // A successful dial after a previous failure must clear the backoff so
    // the next failure restarts at n=1 instead of resuming the geometric
    // schedule from where it left off.
    await input.repo.proxyBackoffs.recordDialSuccess(id, input.upstreamId);
    return response;
  } catch (err) {
    if (err instanceof ProxyDialError) {
      errors.push(err);
      await input.repo.proxyBackoffs.recordDialFailure(id, input.upstreamId, err.message);
      return null;
    }
    throw err;
  }
};

const buildTargetSpec = async (url: string, init: RequestInit): Promise<TargetSpec> => {
  const u = new URL(url);
  return {
    dialHost: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    tls: u.protocol === 'https:',
    method: init.method ?? 'GET',
    path: `${u.pathname}${u.search}`,
    headers: extractHeaders(init.headers),
    requestBody: await collectBody(init.body),
  };
};

const extractHeaders = (input: HeadersInit | undefined): Record<string, string> => {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(input)) return Object.fromEntries(input);
  return { ...input };
};

const collectBody = async (
  body: BodyInit | null | undefined,
): Promise<Uint8Array | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  // FormData / URLSearchParams: round-trip through Request so the runtime
  // produces a canonical multipart/url-encoded byte stream we can buffer.
  // The Request consumer also reads the boundary into Content-Type, but the
  // proxy path adds its own headers from the target spec so we only need
  // the body bytes here.
  if (body instanceof FormData || body instanceof URLSearchParams) {
    return new Uint8Array(await new Request('https://internal/', { method: 'POST', body }).arrayBuffer());
  }
  throw new Error('unsupported BodyInit shape for proxied request');
};
