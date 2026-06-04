// Thin shim: implementation has moved to responses/items/store.ts.
// The old execution path under sources/ still imports from here; this file
// forwards to the new location and exposes the legacy factory signatures.

import {
  LayeredStatefulResponsesStore,
  MemoryStatefulResponsesBacking,
  RepoStatefulResponsesBacking,
  createResponsesHttpStore,
  type StatefulResponsesStore,
  type WebSocketStatefulResponsesStoragePolicy,
} from '../../responses/items/store.ts';
import { getRepo } from '../../../../repo/index.ts';

export type { ResponsesSnapshotMode, StatefulResponsesStore, WebSocketStatefulResponsesStoragePolicy } from '../../responses/items/store.ts';

export const createHttpStatefulResponsesStore = (
  apiKeyId: string | null,
  store: boolean | null | undefined,
): StatefulResponsesStore => createResponsesHttpStore(apiKeyId, store === null ? undefined : store);

export const createWebSocketStatefulResponsesSession = (): {
  createStore(apiKeyId: string | null, store: boolean | null | undefined): WebSocketStatefulResponsesStoragePolicy;
} => {
  const localBacking = new MemoryStatefulResponsesBacking();
  const repoBacking = new RepoStatefulResponsesBacking(getRepo);
  return {
    createStore(apiKeyId: string | null, store: boolean | null | undefined): WebSocketStatefulResponsesStoragePolicy {
      if (store === false) {
        return {
          statefulResponsesStore: new LayeredStatefulResponsesStore({
            apiKeyId,
            reads: [localBacking, repoBacking],
            itemWrites: [{ backing: localBacking, durable: false }],
            snapshotWrites: [{ backing: localBacking, durable: false }],
            stageInputs: true,
          }),
          outputStore: true,
          snapshotMode: 'append',
        };
      }
      const localWrite = { backing: localBacking, durable: false };
      const repoWrite = { backing: repoBacking, durable: true };
      return {
        statefulResponsesStore: new LayeredStatefulResponsesStore({
          apiKeyId,
          reads: [localBacking, repoBacking],
          itemWrites: [localWrite, repoWrite],
          snapshotWrites: [localWrite, repoWrite],
          stageInputs: true,
        }),
        outputStore: store,
        snapshotMode: 'append',
      };
    },
  };
};
