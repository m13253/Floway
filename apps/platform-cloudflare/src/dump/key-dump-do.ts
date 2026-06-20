import type { DumpMetadata } from '@floway-dev/protocols/dump';

// `KeyDumpDO` is a stateless WebSocket fan-out actor — one DO instance per
// api-key id (resolved via `idFromName(keyId)`). The DO accepts WS clients
// from the gateway's SSE handler via `subscribe`, and the gateway's
// capture-dump path drives `publish(meta)` on the same instance after the
// store row is committed. Hibernation lets the actor sleep between bursts
// without dropping live subscribers.
//
// Direct method invocation (`stub.publish(...)`, `stub.notifyDisabled(...)`)
// is the documented RPC path for stateless coordinator DOs — see the
// hibernation example in the Cloudflare docs — so we don't build Request
// objects per publish.

interface KeyDumpState {
  acceptWebSocket(server: WebSocket): void;
  getWebSockets(): WebSocket[];
}

// The WebSocket frame we emit to subscribers. Only `appended` is produced
// today; the gateway-side SSE handler emits its own `error` frames from
// iterator throws, so there is no actor-originated error variant.
interface OutboundFrame {
  event: 'appended';
  data: DumpMetadata;
}

export class KeyDumpDO {
  constructor(private readonly ctx: KeyDumpState, _env: unknown) {}

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
