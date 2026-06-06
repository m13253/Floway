import { describe, expect, it, beforeEach } from 'vitest';

import {
  getSocketDial,
  initSocketDial,
  type SocketDial,
  type DialedSocket,
} from './socket-dial.ts';

describe('SocketDial singleton', () => {
  beforeEach(() => {
    // The module keeps its own state; reset by re-init with a stub.
    initSocketDial({
      connect: async () => {
        throw new Error('stub');
      },
    });
  });

  it('throws when used before init', async () => {
    const { resetSocketDialForTesting } = await import('./socket-dial.ts');
    resetSocketDialForTesting();
    expect(() => getSocketDial()).toThrow('SocketDial not initialized');
  });

  it('returns the registered impl after init', () => {
    const fake: SocketDial = {
      connect: async (_host, _port): Promise<DialedSocket> => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
        closed: Promise.resolve(),
        close: async () => {},
      }),
    };
    initSocketDial(fake);
    expect(getSocketDial()).toBe(fake);
  });
});
