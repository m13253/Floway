import { assertEquals } from "@std/assert";
import { eventResult } from "../shared/errors/result.ts";
import { eventFrame } from "../shared/stream/types.ts";
import {
  runSourceInterceptors,
  type SourceInterceptor,
} from "./run-interceptors.ts";

const collectFrames = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const frames: T[] = [];
  for await (const frame of events) frames.push(frame);
  return frames;
};

Deno.test("runSourceInterceptors lets one interceptor patch payload before run and patch the result after run", async () => {
  const ctx = { payload: { value: "original" } };

  const interceptor: SourceInterceptor<typeof ctx, string> = async (
    current,
    run,
  ) => {
    current.payload.value = "patched";
    const patched = current.payload.value;
    const result = await run();
    if (result.type !== "events") return result;

    return eventResult((async function* () {
      for await (const frame of result.events) {
        yield frame.type === "event"
          ? eventFrame(`${frame.event}:${patched}`)
          : frame;
      }
    })());
  };

  const result = await runSourceInterceptors(
    ctx,
    [interceptor],
    () =>
      Promise.resolve(eventResult((async function* () {
        yield eventFrame(ctx.payload.value);
      })())),
  );

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");
  assertEquals(ctx.payload.value, "patched");
  assertEquals(await collectFrames(result.events), [
    eventFrame("patched:patched"),
  ]);
});

Deno.test("runSourceInterceptors lets one interceptor inspect an upstream error, patch the payload, and retry once", async () => {
  const ctx = { payload: { value: "broken" } };
  let attempts = 0;

  const interceptor: SourceInterceptor<typeof ctx, string> = async (
    current,
    run,
  ) => {
    const first = await run();
    if (first.type !== "upstream-error") return first;

    current.payload.value = "fixed";
    return await run();
  };

  const result = await runSourceInterceptors(ctx, [interceptor], () => {
    attempts += 1;
    return Promise.resolve(
      attempts === 1
        ? {
          type: "upstream-error" as const,
          status: 400,
          headers: new Headers(),
          body: new TextEncoder().encode('{"error":{"message":"broken"}}'),
        }
        : eventResult((async function* () {
          yield eventFrame(ctx.payload.value);
        })()),
    );
  });

  assertEquals(attempts, 2);
  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");
  assertEquals(await collectFrames(result.events), [eventFrame("fixed")]);
});
