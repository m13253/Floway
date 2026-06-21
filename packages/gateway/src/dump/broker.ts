import type { ChannelBroker, Codec } from '../runtime/channel-broker-contract.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Composes with `dumpCodec` below; concrete brokers live in apps/platform-*.
export type DumpBroker = ChannelBroker<DumpMetadata>;

const APPENDED_EVENT = 'appended';

interface AppendedFrame {
  event: typeof APPENDED_EVENT;
  data: DumpMetadata;
}

export const dumpCodec: Codec<DumpMetadata> = {
  encode: meta => JSON.stringify({ event: APPENDED_EVENT, data: meta } satisfies AppendedFrame),
  decode: text => {
    const parsed = JSON.parse(text) as { event: unknown; data: unknown };
    if (parsed.event !== APPENDED_EVENT) {
      throw new Error(`dump broker frame had unexpected event ${String(parsed.event)}`);
    }
    return parsed.data as DumpMetadata;
  },
};

// Reason string surfaced to dashboard subscribers on a clean close.
export const DUMP_DISABLED_REASON = 'dump retention disabled';
