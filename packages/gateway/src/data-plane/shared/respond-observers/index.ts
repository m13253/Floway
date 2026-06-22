import { dumpRespondObserver } from './dump.ts';
import type { ApiKey } from '../../../repo/types.ts';
import type { RespondObserver } from '../respond-observer.ts';

// Dependencies the observer factories may read. Concrete factories opt into
// what they need; future observers (telemetry, audit) extend the shape here.
export interface RespondObserverDeps {
  apiKey: ApiKey;
  startedAt: number;
}

// Re-exported through `../respond-observer.ts` so the contract file is the
// single import path for both the lifecycle hooks and the concrete observers.
export { DumpRespondObserver, dumpRespondObserver } from './dump.ts';

// Walks every registered observer factory and returns the ones that opt in.
// The generic respond-observers middleware stores the result on the request
// context and exposes it via `GatewayCtx.respondObservers`; consumers reach
// observers exclusively through the typed `GatewayCtx` from there on.
// Adding a new observer is: drop a file in this folder, import it here, add
// it to the call list.
export const installRespondObservers = (deps: RespondObserverDeps): RespondObserver[] => {
  const observers: RespondObserver[] = [];
  const dump = dumpRespondObserver(deps);
  if (dump) observers.push(dump);
  return observers;
};
