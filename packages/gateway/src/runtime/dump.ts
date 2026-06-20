import type { DumpBroker, DumpStore } from '@floway-dev/platform';

let _store: DumpStore | null = null;
let _broker: DumpBroker | null = null;

export const setDumpStore = (store: DumpStore): void => {
  _store = store;
};

export const getDumpStore = (): DumpStore => {
  if (!_store) throw new Error('DumpStore not initialized — call setDumpStore() first');
  return _store;
};

export const setDumpBroker = (broker: DumpBroker): void => {
  _broker = broker;
};

export const getDumpBroker = (): DumpBroker => {
  if (!_broker) throw new Error('DumpBroker not initialized — call setDumpBroker() first');
  return _broker;
};
