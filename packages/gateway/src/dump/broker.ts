import type { ChannelBroker, Codec } from '../runtime/channel-broker-contract.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Re-export the generic transport types so platform-target apps can wire a
// `ChannelBroker<T>` implementation and the dump-typed codec in one import.
export type { ChannelBroker, Codec };

// Cloudflare uses a Durable-Object–backed ChannelBroker<DumpMetadata>; Node
// uses an in-process EventTarget-backed one. Both compose with `dumpCodec`
// below — the dump producer and dump subscriber are the only sides that know
// about `event: 'appended'` and the `DumpMetadata` shape.
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

// `closeChannel` cuts any live SSE subscriber. The reason string is the one
// dashboard subscribers see on a clean close — the broker contract is
// transport-shape only, so the dump domain owns this string.
export const DUMP_DISABLED_REASON = 'dump retention disabled';
