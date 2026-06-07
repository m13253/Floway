// Hand-rolled ambient declaration matching this app's convention for runtime types (cf. R2BucketLike, ImagesBinding, KvNamespace) — only the surface used here.
declare module 'cloudflare:sockets' {
  interface CloudflareSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    /** Resolves when the underlying TCP / TLS handshake has finished;
     *  rejects with the connect / handshake error otherwise. */
    readonly opened: Promise<void>;
    close(): Promise<void>;
  }
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface SocketOptions {
    allowHalfOpen: boolean;
    secureTransport?: 'off' | 'on' | 'starttls';
  }
  export const connect: (address: SocketAddress, options?: SocketOptions) => CloudflareSocket;
}
