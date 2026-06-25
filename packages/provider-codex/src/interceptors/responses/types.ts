import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ResponsesAction, UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Codex Responses interceptors. The same ctx feeds both the
// streaming `/responses` (action='generate') and the non-streaming compaction
// (action='compact') chains; the terminal switches on `action` to pick the
// wire shape (see provider.ts callResponses).
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Headers;
  readonly model: UpstreamModel;
  // Mutable: a future codex-side interceptor could pivot the action; today
  // the chain just reads it. The provider terminal handler reads
  // `ctx.action` at the end of the chain to choose generate vs compact.
  action: ResponsesAction;
}
