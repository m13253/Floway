import { DurableObject } from 'cloudflare:workers';
import { test } from 'vitest';

import { BroadcastDO } from './broadcast-do.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Minimal stub of the CF DurableObject runtime surface the actor touches.
// Tests don't run in workerd; install just enough of the WS hibernation API
// for the actor's fetch + broadcast + closeAll + lifecycle-hook paths.
class FakeWebSocket implements WebSocket {
  readyState = 1;
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  url = '';
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSING = 2 as const;
  CLOSED = 3 as const;

  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : '');
  }
  close(code = 1000, reason = ''): void { this.closed = { code, reason }; }
  accept(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
  dispatchEvent(): boolean { return true; }
}

class FakeState {
  readonly sockets: FakeWebSocket[] = [];
  acceptWebSocket(ws: WebSocket): void {
    this.sockets.push(ws as FakeWebSocket);
  }
  getWebSockets(): WebSocket[] {
    return this.sockets;
  }
  push(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }
}

test('BroadcastDO extends DurableObject so the runtime gates RPC dispatch on it', () => {
  // Without `extends DurableObject` the CF runtime rejects direct method
  // invocation (`stub.broadcast(...)`, `stub.closeAll(...)`) with "the
  // receiving Durable Object does not support RPC". A deployment smoke test
  // caught the regression; the unit-test surface doesn't reach the runtime
  // RPC machinery, so we lock the prototype-chain relationship here.
  assertEquals(Object.getPrototypeOf(BroadcastDO.prototype) === DurableObject.prototype, true);
});

test('BroadcastDO.broadcast sends the payload verbatim to every registered socket', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new BroadcastDO(state, {});

  await actor.broadcast('hello world');

  assertEquals(ws1.sent.length, 1);
  assertEquals(ws1.sent[0], 'hello world');
  assertEquals(ws2.sent[0], 'hello world');
});

test('BroadcastDO.closeAll closes every socket with the given reason and code 1000', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new BroadcastDO(state, {});

  await actor.closeAll('reason of the day');

  assertEquals(ws1.closed?.code, 1000);
  assertEquals(ws1.closed?.reason, 'reason of the day');
  assertEquals(ws2.closed?.code, 1000);
  assertEquals(ws2.closed?.reason, 'reason of the day');
});

test('BroadcastDO.webSocketClose calls ws.close to complete the close handshake', async () => {
  const actor = new BroadcastDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketClose(ws, 1001, 'going away', true);
  assertEquals(ws.closed?.code, 1001);
  assertEquals(ws.closed?.reason, 'going away');
});

test('BroadcastDO.webSocketError exists so the runtime delivers close events', async () => {
  // The hook's mere presence is what gates close-event delivery; assert the
  // method is declared on the class itself so the gating contract survives a
  // refactor that mistakes the no-op body for dead code.
  assertEquals(typeof BroadcastDO.prototype.webSocketError, 'function');
  assertEquals(Object.prototype.hasOwnProperty.call(BroadcastDO.prototype, 'webSocketError'), true);
  const actor = new BroadcastDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketError(ws, new Error('whatever'));
  // No side effect — the runtime drops the socket from getWebSockets() on its own.
  assertEquals(ws.closed, null);
});
