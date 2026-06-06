// Local ambient declaration mirrors the convention used elsewhere in this
// app — `R2BucketLike`, `ImagesBinding`, `KvNamespace` are all hand-rolled
// instead of pulling in `@cloudflare/workers-types`. We only declare the
// surface we use, which is `connect()` returning a Web-streams-shaped
// socket.
declare module 'cloudflare:sockets' {
  interface CloudflareSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface SocketOptions {
    allowHalfOpen?: boolean;
    secureTransport?: 'off' | 'on' | 'starttls';
  }
  export const connect: (address: SocketAddress, options?: SocketOptions) => CloudflareSocket;
}
