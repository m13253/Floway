// Runtime-agnostic byte-stream dial primitive. Each apps/platform-* app
// supplies a concrete impl at boot via initSocketDial. packages/proxy
// imports getSocketDial() instead of `cloudflare:sockets` so the same
// proxy library runs on Workers (cloudflare:sockets) and Node (node:net).

export interface DialOptions {
  /** TCP-level. Forwarded to the underlying transport when supported. */
  allowHalfOpen?: boolean;
  /**
   * Wrap the connection with the runtime's native TLS implementation.
   * The hostname is reused as SNI and as the certificate-verify name.
   * Useful when the proxy protocol's outer leg is plain TLS — userspace
   * TLS works too but native TLS is faster.
   */
  tls?: boolean;
}

export interface DialedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Resolves when the underlying transport closes. */
  closed: Promise<void>;
  /** Idempotent close. */
  close(): Promise<void>;
}

export interface SocketDial {
  connect(host: string, port: number, opts?: DialOptions): Promise<DialedSocket>;
}

let current: SocketDial | null = null;

export const initSocketDial = (impl: SocketDial): void => {
  current = impl;
};

export const getSocketDial = (): SocketDial => {
  if (!current) throw new Error('SocketDial not initialized');
  return current;
};

/** Test-only: resets the module-level singleton. Not exported from index.ts. */
export const resetSocketDialForTesting = (): void => {
  current = null;
};
