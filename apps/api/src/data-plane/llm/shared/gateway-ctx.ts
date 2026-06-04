import type { Context } from 'hono';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';

export interface GatewayCtx {
  readonly apiKeyId: string | null;
  readonly apiKeyUpstreamIds: readonly string[] | null;
  readonly headers: Headers;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly scheduleBackground: (fn: () => Promise<void> | void) => void;
}

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  const scheduleBackground = backgroundScheduler !== undefined
    ? (fn: () => Promise<void> | void) => backgroundScheduler(Promise.resolve(fn()))
    : (_fn: () => Promise<void> | void) => {};
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    headers: new Headers(),
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    scheduleBackground,
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  _server: WebSocket,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  const scheduleBackground = backgroundScheduler !== undefined
    ? (fn: () => Promise<void> | void) => backgroundScheduler(Promise.resolve(fn()))
    : (_fn: () => Promise<void> | void) => {};
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    headers: new Headers(),
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    scheduleBackground,
  };
};
