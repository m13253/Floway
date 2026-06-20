import type { DumpBroker, DumpStore } from '@floway-dev/platform';

let _store: DumpStore | null = null;
let _broker: DumpBroker | null = null;

export const initDumpStore = (store: DumpStore): void => {
  _store = store;
};

export const getDumpStore = (): DumpStore => {
  if (!_store) throw new Error('DumpStore not initialized — call initDumpStore() first');
  return _store;
};

export const initDumpBroker = (broker: DumpBroker): void => {
  _broker = broker;
};

export const getDumpBroker = (): DumpBroker => {
  if (!_broker) throw new Error('DumpBroker not initialized — call initDumpBroker() first');
  return _broker;
};
