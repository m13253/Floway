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
//
// Streaming bodies (`init.body instanceof ReadableStream`) are rejected
// upfront because the two-pass dial can replay a request, and a stream is
// single-shot. Buffer streaming bodies in the caller before reaching here.
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
    if (list.length === 1) {
      const err = errors[errors.length - 1];
      if (!err) throw new Error('unreachable: no errors on single-entry exhaustion');
      throw err;
    }
    throw new AggregateError(errors, 'all proxies failed at the dial layer');
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
      // Tag the persisted message with the dial stage so a dashboard reader
      // can tell a tcp-connect refusal from an inner-tls cert mismatch
      // without cracking the proxy library open.
      await input.repo.proxyBackoffs.recordDialFailure(id, input.upstreamId, `[${err.stage}] ${err.message}`);
      return null;
    }
    throw err;
  }
};

const buildTargetSpec = async (url: string, init: RequestInit): Promise<TargetSpec> => {
  const u = new URL(url);
  const collected = await collectBody(init.body);
  const headers = extractHeaders(init.headers);
  // FormData/URLSearchParams synthesize a Content-Type with the multipart
  // boundary or the urlencoded marker. Adopt it only when the caller did not
  // pre-set Content-Type itself, so explicit overrides keep winning.
  if (collected?.contentType !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = collected.contentType;
  }
  return {
    dialHost: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    tls: u.protocol === 'https:',
    method: init.method ?? 'GET',
    path: `${u.pathname}${u.search}`,
    headers,
    requestBody: collected?.body,
  };
};

// Header keys are lowercased so downstream emit-stage code (HTTP/1.1
// formatter, header dedup) sees a single canonical casing regardless of
// what the caller used.
const extractHeaders = (input: HeadersInit | undefined): Record<string, string> => {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of input) out[k.toLowerCase()] = v;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k.toLowerCase()] = v;
  return out;
};

interface CollectedBody {
  body: Uint8Array;
  /** Content-Type the runtime synthesizes for FormData/URLSearchParams (with
   *  multipart boundary or urlencoded marker). undefined for shapes that
   *  carry no implicit Content-Type. */
  contentType?: string;
}

const collectBody = async (
  body: BodyInit | null | undefined,
): Promise<CollectedBody | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return { body: new TextEncoder().encode(body) };
  if (body instanceof Uint8Array) return { body };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
  if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()) };
  if (body instanceof ReadableStream) {
    // The two-pass dial can replay a request, and a stream is single-shot.
    // Surface this constraint as an explicit error — the caller must buffer
    // streaming bodies before they reach the proxy fetcher.
    throw new Error('streaming request bodies are not yet supported through proxies');
  }
  // FormData / URLSearchParams: round-trip through Request so the runtime
  // produces a canonical multipart/url-encoded byte stream we can buffer
  // alongside the synthesized Content-Type (with boundary or charset).
  if (body instanceof FormData || body instanceof URLSearchParams) {
    const req = new Request('https://internal/', { method: 'POST', body });
    const buffer = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? undefined;
    return { body: buffer, contentType };
  }
  throw new Error('unsupported BodyInit shape for proxied request');
};
