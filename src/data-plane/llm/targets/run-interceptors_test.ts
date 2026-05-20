import { assertEquals } from "@std/assert";
import { eventResult } from "../shared/errors/result.ts";
import { jsonFrame } from "../shared/stream/types.ts";
import {
  runTargetInterceptors,
  type TargetInterceptor,
} from "./run-interceptors.ts";

const collectFrames = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const frames: T[] = [];

  for await (const frame of events) {
    frames.push(frame);
  }

  return frames;
};

const testTelemetryModelIdentity = {
  model: "test-model",
  upstream: "test-upstream",
  modelKey: "test-model-key",
};

Deno.test("runTargetInterceptors lets one interceptor patch request before run and patch the matching response after run", async () => {
  const ctx = { payload: { value: "original" } };

  const interceptor: TargetInterceptor<typeof ctx, string> = async (
    current,
    run,
  ) => {
    current.payload.value = "patched";
    const patchedValue = current.payload.value;
    const result = await run();

    if (result.type !== "events") return result;

    return {
      ...result,
      events: (async function* () {
        for await (const frame of result.events) {
          yield frame.type === "json"
            ? jsonFrame(`${frame.data}:${patchedValue}`)
            : frame;
        }
      })(),
    };
  };

  const result = await runTargetInterceptors(
    ctx,
    [interceptor],
    () =>
      Promise.resolve(eventResult(
        (async function* () {
          yield jsonFrame(ctx.payload.value);
        })(),
        testTelemetryModelIdentity,
      )),
  );

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");
  assertEquals(ctx.payload.value, "patched");
  assertEquals(await collectFrames(result.events), [
    jsonFrame("patched:patched"),
  ]);
});

Deno.test("runTargetInterceptors lets one interceptor inspect an upstream error, patch the request, and retry once", async () => {
  const ctx = { payload: { value: "broken" } };
  let attempts = 0;

  const interceptor: TargetInterceptor<typeof ctx, string> = async (
    current,
    run,
  ) => {
    const first = await run();
    if (first.type !== "upstream-error") return first;

    current.payload.value = "fixed";
    return await run();
  };

  const result = await runTargetInterceptors(ctx, [interceptor], () => {
    attempts += 1;

    return Promise.resolve(
      attempts === 1
        ? {
          type: "upstream-error" as const,
          status: 400,
          headers: new Headers(),
          body: new TextEncoder().encode('{"error":{"message":"broken"}}'),
        }
        : eventResult(
          (async function* () {
            yield jsonFrame(ctx.payload.value);
          })(),
          testTelemetryModelIdentity,
        ),
    );
  });

  assertEquals(attempts, 2);
  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");
  assertEquals(await collectFrames(result.events), [jsonFrame("fixed")]);
});
