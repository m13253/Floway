import { test } from 'vitest';

import { KeyDumpDO } from './key-dump-do.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

// Minimal stub of the CF DurableObject runtime surface the actor touches.
// Tests don't run in workerd; we install just enough of the WS hibernation
// API for the actor's fetch + publish + notifyDisabled paths.
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
  private readonly sockets: FakeWebSocket[] = [];
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

const fakeMeta = (id: string): DumpMetadata => ({
  id, startedAt: 0, completedAt: 1, method: 'POST', path: '/v1/x', status: 200,
  upstream: null, model: null, inputTokens: null, outputTokens: null,
  requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
});

test('KeyDumpDO.publish sends an appended frame to every registered socket', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new KeyDumpDO(state, {});

  await actor.publish(fakeMeta('A1'));

  assertEquals(ws1.sent.length, 1);
  assertEquals(ws2.sent.length, 1);
  const parsed = JSON.parse(ws1.sent[0]!) as { event: string; data: DumpMetadata };
  assertEquals(parsed.event, 'appended');
  assertEquals(parsed.data.id, 'A1');
});

test('KeyDumpDO.publish swallows per-socket send errors so one dead socket cannot block fan-out', async () => {
  const state = new FakeState();
  const bad = new FakeWebSocket();
  bad.shouldThrowOnSend = true;
  const good = new FakeWebSocket();
  state.push(bad);
  state.push(good);
  const actor = new KeyDumpDO(state, {});

  await actor.publish(fakeMeta('A2'));
  assertEquals(good.sent.length, 1);
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
