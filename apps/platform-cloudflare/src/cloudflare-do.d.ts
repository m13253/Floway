// Hand-rolled ambient declaration for the Durable Object surface this app
// uses from cloudflare:workers and the runtime globals (DurableObjectState,
// DurableObjectNamespace, WebSocketPair). We model only the methods KeyDumpDO
// touches so the runtime contract does not pull in the full
// @cloudflare/workers-types package — same convention as
// cloudflare-sockets.d.ts and the other "Like" shapes in this directory.
// References:
// - https://developers.cloudflare.com/durable-objects/api/state/
// - https://developers.cloudflare.com/durable-objects/api/storage-api/
// - https://developers.cloudflare.com/durable-objects/best-practices/websockets/

interface SqlStorageCursor<T> {
  toArray(): T[];
  one(): T | undefined;
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectId {
  readonly name?: string;
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  // The returned stub combines fetch() with RPC: every public method on the
  // bound DO class is callable on the stub with its original signature,
  // modulo Promise wrapping (already async in our case).
  get(id: DurableObjectId): DurableObjectStub & T;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

interface ResponseInit {
  webSocket?: WebSocket;
}

interface Response {
  readonly webSocket: WebSocket | null;
}

interface WebSocket {
  accept(): void;
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}
