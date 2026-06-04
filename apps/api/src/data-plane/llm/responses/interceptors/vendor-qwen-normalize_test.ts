import { test } from 'vitest';

import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';
import type { ResponsesInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import type { ModelProviderInstance } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';

const stubProviderInstance = (): ModelProviderInstance => ({ provider: stubProvider() } as unknown as ModelProviderInstance);

const stubCtx: GatewayCtx = {
  apiKeyId: null,
  apiKeyUpstreamIds: null,
  headers: new Headers(),
  wantsStream: false,
  scheduleBackground: () => {},
  requestStartedAt: 0,
};

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen'])): ResponsesInvocation => ({
  payload,
  candidate: {
    provider: stubProviderInstance(),
    binding: {
      upstream: 'test-upstream',
      upstreamName: 'test-upstream',
      providerKind: 'custom',
      provider: stubProvider(),
      upstreamModel: stubUpstreamModel(),
      enabledFlags,
      supportsResponsesItemReference: false,
    },
    targetApi: 'responses',
  },
  store: new LayeredStatefulResponsesStore({
    apiKeyId: null,
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
});

test("vendor-qwen translates canonical reasoning.effort: 'none' into top-level enable_thinking:false", async () => {
  const input = invocation({
    model: 'qwen-max',
    input: 'hi',
    reasoning: { effort: 'none' },
  });

  await withVendorQwenResponsesNormalize(input, stubCtx, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.enable_thinking, false);
});

test('vendor-qwen leaves a real reasoning.effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'high' } });

  await withVendorQwenResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('vendor-qwen early-returns when its flag is not set on the binding', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'none' } }, new Set());

  await withVendorQwenResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
