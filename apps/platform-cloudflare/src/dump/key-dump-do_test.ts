import { test } from 'vitest';

import { KeyDumpDO } from './key-dump-do.ts';
import { assertEquals, fakeMeta } from '@floway-dev/test-utils';

// Minimal stub of the CF DurableObject runtime surface the actor touches.
// Tests don't run in workerd; install just enough of the WS hibernation API
// for the actor's fetch + publish + notifyDisabled + lifecycle-hook paths.
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
  shouldThrowOnSend = false;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.shouldThrowOnSend) throw new Error('socket gone');
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

test('KeyDumpDO.publish sends an appended frame to every registered socket', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new KeyDumpDO(state, {});

  await actor.publish(fakeMeta({ id: 'A1' }));

  assertEquals(ws1.sent.length, 1);
  assertEquals(ws2.sent.length, 1);
  const parsed = JSON.parse(ws1.sent[0]!) as { event: string; data: { id: string } };
  assertEquals(parsed.event, 'appended');
  assertEquals(parsed.data.id, 'A1');
});

test('KeyDumpDO.notifyDisabled closes every socket with a clean reason', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new KeyDumpDO(state, {});

  await actor.notifyDisabled();
  assertEquals(ws1.closed?.code, 1000);
  assertEquals(ws2.closed?.code, 1000);
});

test('KeyDumpDO.webSocketClose calls ws.close to complete the close handshake', async () => {
  // Under `compatibility_date < 2026-04-07` the runtime delivers close events
  // only when the hook is declared, and the hook must call `ws.close(...)` so
  // the close handshake completes — without it the client sees `1006`.
  const actor = new KeyDumpDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketClose(ws, 1001, 'going away', true);
  assertEquals(ws.closed?.code, 1001);
  assertEquals(ws.closed?.reason, 'going away');
});

test('KeyDumpDO.webSocketError exists so the runtime delivers close events', async () => {
  // The hook's mere presence is what gates close-event delivery; without it
  // a deleted method would still satisfy the call via prototype inheritance.
  // Assert the method is declared on the class itself so the gating contract
  // survives a refactor that mistakes the no-op body for dead code.
  assertEquals(typeof KeyDumpDO.prototype.webSocketError, 'function');
  assertEquals(Object.prototype.hasOwnProperty.call(KeyDumpDO.prototype, 'webSocketError'), true);
  const actor = new KeyDumpDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketError(ws, new Error('whatever'));
  // No side effect — the runtime drops the socket from getWebSockets() on its own.
  assertEquals(ws.closed, null);
});
