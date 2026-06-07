// Helper duplex for @floway-dev/http tests.
//
// Same intent as packages/proxy's fake-socket-dial: pair a duplex that the
// HTTP layer reads/writes against with a server-side handle that asserts on
// emitted bytes and feeds in crafted server responses (chunked, malformed,
// CL+TE smuggling vectors, …).

export interface FakeDuplex {
  // Consumed by @floway-dev/http as the network side.
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  /** Returns all bytes the HTTP layer has written so far. */
  written(): Uint8Array;
  /** Resolves once the writable is closed by the HTTP layer. */
  waitWritableClosed(): Promise<void>;

  /** Push bytes into the readable. */
  respond(bytes: Uint8Array | string): void;
  /** Close the readable (server EOF). */
  endResponse(): void;
}

export const makeFakeDuplex = (): FakeDuplex => {
  let writeBuffer = new Uint8Array(0);
  let writableClosedResolve: (() => void) | null = null;
  const writableClosedPromise = new Promise<void>(r => { writableClosedResolve = r; });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const next = new Uint8Array(writeBuffer.byteLength + chunk.byteLength);
      next.set(writeBuffer, 0);
      next.set(chunk, writeBuffer.byteLength);
      writeBuffer = next;
    },
    close() { writableClosedResolve?.(); },
    abort() { writableClosedResolve?.(); },
  });

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });

  const enc = new TextEncoder();

  return {
    readable,
    writable,
    written: () => new Uint8Array(writeBuffer),
    waitWritableClosed: () => writableClosedPromise,
    respond(bytes) {
      const u = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
      controller.enqueue(new Uint8Array(u));
    },
    endResponse() { controller.close(); },
  };
};

export const collectBody = async (resp: Response): Promise<string> => {
  const buf = await resp.arrayBuffer();
  return new TextDecoder().decode(buf);
};
