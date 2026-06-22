import type { Context } from 'hono';

import { dumpRespondObserver } from './dump.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { addRespondObserver } from '../respond-observer.ts';

// Dependencies the observer factories may read. Concrete factories opt into
// what they need; future observers (telemetry, audit) extend the shape here.
export interface RespondObserverDeps {
  apiKey: ApiKey;
  startedAt: number;
}

// Re-exported through `../respond-observer.ts` so the contract file is the
// single import path for both the lifecycle hooks and the concrete observers.
export { DumpRespondObserver, dumpRespondObserver } from './dump.ts';
export type { DumpAccounting } from './dump.ts';

// Result of installing the full observer set against a Hono context.
// Each field holds the concrete observer instance (or null when its factory
// chose to opt out for this request) so the caller can read state back from
// a specific observer without re-walking the context-registered list.
export interface InstalledRespondObservers {
  dump: ReturnType<typeof dumpRespondObserver>;
}

// Walks every registered observer factory, instantiates the ones that opt in,
// and registers them against the Hono context so the dispatcher fans
// lifecycle events out to all of them. Returns the per-observer references so
// the caller can pull state back at the end of the request (e.g. the
// middleware that finalises the dump record reads `dump.events` and
// `dump.accounting`). Adding a new observer is: drop a file in this folder,
// import it here, add it to the call list.
export const installRespondObservers = (c: Context, deps: RespondObserverDeps): InstalledRespondObservers => {
  const dump = dumpRespondObserver(c, deps);
  if (dump) addRespondObserver(c, dump);
  return { dump };
};
