import type { Context } from 'hono';

import { executeLlmSourcePlan } from './execution.ts';
import { createHttpRequestContext } from './request-context.ts';
import { type LlmEndpointName, type LlmServeFailure, LlmServeFailureError, type LlmSourceRuntime, type LlmSourceTraits, type Result } from './traits.ts';

// HTTP adapter for every LLM source endpoint. The adapter owns Hono request
// setup and Response rendering; the Hono-free execution core owns stored-item
// lookup, provider selection, per-attempt execution, and output-item commit
// timing.
//
// A source declares one or more endpoints (generate, count_tokens);
// `serveLlm(traits, endpointName)` binds one of them to a route. `prepare(c)`
// parses the body, runs HTTP/input-level pre-checks (returning an early
// `Response`), and yields a plan whose `attempt` closure captures the parsed
// payload to clone, rewrite, and run.

export const serveLlm = <TItems, TEvent>(
  traits: LlmSourceTraits<TItems, TEvent>,
  endpointName: LlmEndpointName,
) => {
  const endpoint = traits.endpoints[endpointName];
  if (!endpoint) throw new Error(`LLM source does not define the '${endpointName}' endpoint.`);

  return async (c: Context): Promise<Response> => {
    // Runtime starts provisional so a parse or prepare throw can still be
    // rendered with telemetry; prepare replaces it on success.
    // `respond` closes over them so every call site — early diagnostic, main
    // path, and catch — renders identically.
    let runtime: LlmSourceRuntime = {
      request: createHttpRequestContext(c, undefined, false),
      wantsStream: false,
      downstreamAbortController: undefined,
    };
    const respond = (result: Result<TEvent>): Promise<{ success: boolean; response: Response }> =>
      endpoint.respond({ c, result, runtime });
    const renderFailure = (failure: LlmServeFailure): Result<TEvent> => traits.renderFailure(failure, endpointName);

    try {
      const plan = await endpoint.prepare(c);
      if (plan instanceof Response) return plan;
      runtime = plan;

      const { result, commitForNonStreaming } = await executeLlmSourcePlan(plan, renderFailure);

      // `respond` reports only whether the response was produced; the orchestrator
      // owns commit timing. `commitForNonStreaming` exists solely on a successful
      // non-streaming attempt — it flushes the buffered rows once the body is
      // known good (streaming rows were already written per frame). A failed
      // response leaves the buffer unflushed.
      const { success, response } = await respond(result);
      if (success) await commitForNonStreaming?.();
      return response;
    } catch (error) {
      const failure: LlmServeFailure = error instanceof LlmServeFailureError ? error.failure : { kind: 'internal', error };
      return (await respond(renderFailure(failure))).response;
    }
  };
};
