import { DurableObject } from 'cloudflare:workers';

import type { DumpMetadata } from '@floway-dev/protocols/dump';

// `KeyDumpDO` is a stateless WebSocket fan-out actor — one DO instance per
// api-key id (resolved via `idFromName(keyId)`). The DO accepts WS clients
// from the gateway's SSE handler via `fetch`, and the gateway's
// capture-dump path drives `publish(meta)` on the same instance after the
// store row is committed. Hibernation lets the actor sleep between bursts
// without dropping live subscribers.
//
// `extends DurableObject` is load-bearing: the CF runtime gates RPC method
// dispatch (`stub.publish(...)`, `stub.notifyDisabled(...)`) on the actor
// extending this base class. Without it, the runtime rejects the call with
// "the receiving Durable Object does not support RPC" and the broker's
// publish path silently fails (errors flow through `waitUntil`), starving
// SSE subscribers of `appended` frames.

// The WebSocket frame we emit to subscribers. Only `appended` is produced
// today; the gateway-side SSE handler emits its own `error` frames from
// iterator throws, so there is no actor-originated error variant.
interface OutboundFrame {
  event: 'appended';
  data: DumpMetadata;
}

export class KeyDumpDO extends DurableObject {
  // The base class's constructor signature is what the CF runtime invokes;
  // declared explicitly here so the type-check sees `(ctx, env)` even when
  // the `cloudflare:workers` types resolve to a parameterless base.
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(meta: DumpMetadata): Promise<void> {
    const payload = JSON.stringify({ event: 'appended', data: meta } satisfies OutboundFrame);
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
  }

  async notifyDisabled(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'dump retention disabled');
  }

  // Hibernation hooks. With compatibility_date < 2026-04-07 the runtime
  // delivers close events only when these hooks are declared on the actor,
  // and `webSocketClose` must call `ws.close(code, reason)` to complete the
  // close handshake from the actor side — without it the client sees a
  // `1006 abnormal closure` and the actor holds the dead socket until the
  // hibernation timeout. `webSocketError` is a no-op; the runtime drops the
  // socket from `getWebSockets()` once the hook returns.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}
