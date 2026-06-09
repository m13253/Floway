// Runtime-agnostic byte-stream dial primitive. Each apps/platform-* app
// supplies a concrete impl at boot via initSocketDial; the gateway calls
// getSocketDial() at the dial-layer composition root and threads the
// resulting SocketDial into @floway-dev/proxy. The proxy library never
// imports a runtime module like `cloudflare:sockets` directly, so the same
// dialers run on Workers (cloudflare:sockets) and Node (node:net).

interface SocketDialOptions {
  /**
   * Wrap the connection with the runtime's native TLS implementation.
   * The hostname is reused as SNI and as the certificate-verify name.
   * Useful when the proxy protocol's outer leg is plain TLS — userspace
   * TLS works too but native TLS is faster.
   */
  tls?: boolean;
  /**
   * Caller-supplied cancellation. When the signal aborts:
   *   - mid-connect dials are torn down immediately;
   *   - established sockets are closed by the runtime impl, which then
   *     surfaces as read/write rejections to the proxy library.
   * The signal is also honoured pre-connect: a signal that is already
   * aborted at call time throws synchronously without opening a socket —
   * its Error reason is rethrown as-is, and a primitive or absent reason
   * becomes a DOMException('AbortError').
   */
  signal?: AbortSignal;
}

export interface DialedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Idempotent close. */
  close(): Promise<void>;
}

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
}

let current: SocketDial | null = null;

export const initSocketDial = (impl: SocketDial): void => {
  current = impl;
};

export const getSocketDial = (): SocketDial => {
  if (!current) throw new Error('SocketDial not initialized');
  return current;
};

/** Test-only: clears the module singleton. */
export const resetSocketDialForTesting = (): void => {
  current = null;
};

/**
 * Convert a caller-supplied abort signal into a thrown error shaped for
 * the dial chain's AbortError fast-path. A structured Error reason is
 * rethrown as-is so its stack/cause survives; a primitive or absent
 * reason becomes a DOMException('AbortError').
 */
export const throwAbort = (signal: AbortSignal): never => {
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason ?? 'aborted'), 'AbortError');
};
