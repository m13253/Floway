import { describe, expect, it, beforeEach } from 'vitest';

import {
  getSocketDial,
  initSocketDial,
  resetSocketDialForTesting,
  type SocketDial,
  type DialedSocket,
} from './socket-dial.ts';

describe('SocketDial singleton', () => {
  beforeEach(() => {
    initSocketDial({
      connect: async () => {
        throw new Error('stub');
      },
    });
  });

  it('throws when used before init', () => {
    resetSocketDialForTesting();
    expect(() => getSocketDial()).toThrow('SocketDial not initialized');
  });

  it('returns the registered impl after init', () => {
    const fake: SocketDial = {
      connect: async (_host, _port): Promise<DialedSocket> => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
        close: async () => {},
      }),
    };
    initSocketDial(fake);
    expect(getSocketDial()).toBe(fake);
  });
});
