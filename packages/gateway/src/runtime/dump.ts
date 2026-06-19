import type { DumpBroker, DumpStore } from '@floway-dev/platform';

let _dumpStore: DumpStore | null = null;
let _dumpBroker: DumpBroker | null = null;

export const initDumpStore = (s: DumpStore): void => { _dumpStore = s; };
export const initDumpBroker = (b: DumpBroker): void => { _dumpBroker = b; };

export const getDumpStore = (): DumpStore => {
  if (!_dumpStore) throw new Error('DumpStore not initialized — call initDumpStore() first');
  return _dumpStore;
};
export const getDumpBroker = (): DumpBroker => {
  if (!_dumpBroker) throw new Error('DumpBroker not initialized — call initDumpBroker() first');
  return _dumpBroker;
};
