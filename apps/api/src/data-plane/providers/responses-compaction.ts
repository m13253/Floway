import type { ProviderCallResult, ProviderCompactionResult } from './types.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

// Upstreams with a native `/responses/compact` (Azure, custom) answer with the
// `response.compaction` envelope directly; parse it into the result value the
// target turns into frames, leaving an upstream error response untouched so the
// boundary reports it verbatim.
export const nativeCompactionResult = async (call: Promise<ProviderCallResult>): Promise<ProviderCompactionResult> => {
  const { response, modelKey } = await call;
  return response.ok ? { ok: true, result: (await response.json()) as ResponsesResult, modelKey } : { ok: false, response, modelKey };
};
