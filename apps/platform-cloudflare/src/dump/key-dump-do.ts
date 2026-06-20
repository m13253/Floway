import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal hand-rolled shape of the Durable Object surface we depend on; the
// platform-cloudflare app deliberately does not pull in the full workers-types
// surface and uses targeted typing for each binding it touches.
//
// `KeyDumpDO` is a stateless WebSocket fan-out actor — one DO instance per
// api-key id (resolved via `idFromName(keyId)`). The DO accepts WS clients
// from the gateway's SSE handler via `subscribe`, and the gateway's
// capture-dump path drives `publish(meta)` on the same instance after the
// store row is committed. Hibernation lets the actor sleep between bursts
// without dropping live subscribers.

interface KeyDumpState {
  acceptWebSocket(server: WebSocket): void;
  getWebSockets(): WebSocket[];
}

interface KeyDumpEnv { /* no env access; the DO is stateless */ }

// The WebSocket frame we emit to subscribers. `event` discriminates
// `appended` (a new dump record landed) from `error` (a publish-side fault
// the gateway wants to surface to the client). The SSE adapter on the
// gateway side maps both directly onto outbound SSE events.
interface OutboundFrame {
  event: 'appended' | 'error';
  data: unknown;
}

// We expose `publish` and `notifyDisabled` as RPC-style methods on the DO
// stub. The CF runtime auto-forwards `stub.method(...)` invocations through
// the worker→DO RPC bridge when both sides are typed on the same class;
// fetch-style POSTs would work too but cost a Request build on every call.
// Direct method invocation is the documented path for stateless coordinator
// DOs (Cloudflare's own examples in the WebSocket hibernation docs).
export class KeyDumpDO {
  constructor(private readonly ctx: KeyDumpState, _env: KeyDumpEnv) {}

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(meta: DumpMetadata): Promise<void> {
    const frame: OutboundFrame = { event: 'appended', data: meta };
    const payload = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // The socket has already closed on the other side; the matching
        // `webSocketClose` will detach it from the hibernation registry
        // shortly. There's nothing left to do here.
      }
    }
  }

  async notifyDisabled(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'dump retention disabled');
      } catch {
        // Idem: closing an already-closed socket is a no-op for our purposes.
      }
    }
  }
}
