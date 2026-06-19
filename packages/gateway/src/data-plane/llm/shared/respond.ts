import type { Context } from 'hono';

import type { StreamCompletion } from './stream/sse.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { recordRequestPerformance } from '../../shared/telemetry/performance.ts';
import { hasTokenUsage, recordTokenUsage } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { plainResult } from '@floway-dev/provider';
import type { EventResultMetadata, ExecuteResult, PlainResult, TelemetryModelIdentity } from '@floway-dev/provider';

// Emits a measurement endpoint's already-shaped body verbatim. The endpoint's
// `attempt` owns all shaping — the success body and any source-specific error
// envelope — so every source's `respond` renders a plain result identically.
export const plainResultToResponse = (result: PlainResult): Response =>
  new Response(result.body.slice().buffer, { status: result.status, headers: result.headers });

// Captures an upstream HTTP response as a plain result, keeping its status and
// content type. Used by count_tokens endpoints that either pass through the
// upstream body or wrap an already-built error/success Response.
export const plainResultFromResponse = async (response: Response): Promise<PlainResult> =>
  plainResult(
    response.status,
    new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' }),
    new Uint8Array(await response.arrayBuffer()),
  );

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;
  usage: TokenUsage | null = null;

  // Only a frame carrying real (non-zero) usage overwrites the running figure,
  // so an empty trailing frame can't wipe a good count.
  rememberUsage(usage: TokenUsage | null): void {
    if (usage && hasTokenUsage(usage)) this.usage = usage;
  }

  // Whether the streamed response should be recorded as failed: an upstream or
  // internal error frame set `failed`, the writer reported an error completion,
  // or the client cancelled before the terminal frame arrived.
  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

// The events result's metadata, resolved once: prefer the upstream's finalized
// metadata, else fall back to the identity/performance carried on the result.
export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });

export const recordUsage = async (ctx: GatewayCtx, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordTokenUsage(ctx.apiKeyId, modelIdentity, usage);
};

export const recordPerformance = (ctx: GatewayCtx, context: EventResultMetadata['performance'], failed: boolean): void => {
  recordRequestPerformance(ctx.backgroundScheduler, context, failed, performance.now() - ctx.requestStartedAt);
};

// Upstream-emitted hints we propagate verbatim to the downstream client.
//
// The prefix list covers Anthropic's plan-billing surface: the
// `anthropic-ratelimit-unified-*` family carries quotas, resets, and warning
// thresholds, and the official `claude-code` CLI's `/status` indicator reads
// them. Dropping the headers makes the gateway look like an account with no
// rate-limit state. The allowlist is by prefix so new dimensions the upstream
// introduces (e.g. a future `anthropic-ratelimit-tier-*`) are forwarded
// automatically.
//
// The exact-name list covers operator-trace identifiers — `request-id` /
// `x-request-id` (Anthropic / OpenAI vendor traces) and `cf-ray` (Cloudflare's
// edge trace). Support tickets and live debugging rely on these reaching the
// downstream client unmodified.
const FORWARDED_HEADER_PREFIXES = ['anthropic-ratelimit-'] as const;
const FORWARDED_HEADER_NAMES = new Set(['request-id', 'x-request-id', 'cf-ray']);

const isForwardableUpstreamHeader = (name: string): boolean => {
  const lowered = name.toLowerCase();
  if (FORWARDED_HEADER_NAMES.has(lowered)) return true;
  return FORWARDED_HEADER_PREFIXES.some(prefix => lowered.startsWith(prefix));
};

// Stages allowlisted upstream headers onto the Hono context so the next
// `c.newResponse` (or `streamSSE`'s internal `c.newResponse`) emits them on
// the response. Hono's `c.header()` is the only knob that survives a later
// `c.json` or `streamSSE` call without being overwritten. Safe to call with
// `undefined` so callers can pass `result.headers` directly.
export const forwardUpstreamHeaders = (c: Context, headers: Headers | undefined): void => {
  if (!headers) return;
  for (const [name, value] of headers) {
    if (isForwardableUpstreamHeader(name)) c.header(name, value);
  }
};

// Returns a `HeadersInit` extending `base` with every allowlisted entry from
// `upstream`. Used by non-streaming JSON responses where the response is
// built directly (`Response.json(...)`) instead of through Hono's `c`.
export const mergeForwardedUpstreamHeaders = (base: HeadersInit | undefined, upstream: Headers | undefined): HeadersInit => {
  const merged = new Headers(base);
  if (upstream) {
    for (const [name, value] of upstream) {
      if (isForwardableUpstreamHeader(name)) merged.set(name, value);
    }
  }
  return merged;
};
