import type { Context } from 'hono';

export interface GatewayCtx {
  readonly apiKeyId: string | null;
  readonly apiKeyUpstreamIds: readonly string[] | null;
  readonly headers: Headers;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
}

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    headers: new Headers(),
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  _server: WebSocket,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    headers: new Headers(),
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
  };
};
