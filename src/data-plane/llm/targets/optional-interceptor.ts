// Descriptor a target's interceptors/index.ts uses to bind an interceptor
// run function to a flag declared in ../../providers/fixes.ts. The
// dependency is one-way: the interceptor knows which flag it subscribes
// to (by id); the flag has no awareness of subscribers. `fixId` is typed
// against the catalog so a typo or rename is a compile error.

import type { TargetInterceptor } from "./run-interceptors.ts";
import type { OptionalFixId } from "../../providers/fixes.ts";

export interface OptionalInterceptor<TContext, TJson> {
  fixId: OptionalFixId;
  run: TargetInterceptor<TContext, TJson>;
}
