import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { createGatewayCtxFromHono, type GatewayCtxAuthVars } from './gateway-ctx.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Mirrors the production guarantee: by the time a data-plane handler runs,
// auth middleware has stamped all three vars on the context. Tests that want
// to model an unrestricted key on an uncapped user can rely on the defaults;
// tests that want to model a capped key or user override at the handler.
const makeApp = (): Hono<{ Variables: GatewayCtxAuthVars }> => {
  const app = new Hono<{ Variables: GatewayCtxAuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKeyId', 'test-key');
    c.set('apiKeyUpstreamIds', null);
    c.set('userUpstreamIds', null);
    await next();
  });
  return app;
};

describe('createGatewayCtxFromHono', () => {
  test('copies auth fields when both are set', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      c.set('apiKeyId', 'key-1');
      c.set('apiKeyUpstreamIds', ['up-1', 'up-2']);
      ctx = createGatewayCtxFromHono(c, { wantsStream: true });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'key-1');
    assertEquals(ctx.upstreamIds, ['up-1', 'up-2']);
  });

  test('passes upstreamIds through as null on an unrestricted key + uncapped user', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'test-key');
    assertEquals(ctx.upstreamIds, null);
  });

  test('respects wantsStream=true', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: true });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('respects wantsStream=false', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, false);
  });

  test('wantsStream=true: downstreamAbortController is defined and abortSignal matches its signal', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: true });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.downstreamAbortController);
    assertEquals(ctx.abortSignal, ctx.downstreamAbortController.signal);
  });

  test('wantsStream=false: downstreamAbortController and abortSignal are both undefined', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.downstreamAbortController, undefined);
    assertEquals(ctx.abortSignal, undefined);
  });

  test('caller-supplied downstreamAbortController overrides the factory-minted one (websocket path)', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, downstreamAbortController: controller });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.downstreamAbortController, controller);
    assertEquals(ctx.abortSignal, controller.signal);
    assertEquals(ctx.wantsStream, true);
  });

  test('backgroundScheduler is present and callable', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.backgroundScheduler);
    ctx.backgroundScheduler(Promise.resolve());
  });

  test('upstreamIds is the intersection of the per-user cap and the per-key whitelist', async () => {
    // Drives the headline multi-tenant invariant: an unrestricted key under a
    // capped user must not route to upstreams outside the user's cap.
    const app = makeApp();
    const collected: { capOnly?: readonly string[] | null; both?: readonly string[] | null; keyOnly?: readonly string[] | null } = {};
    app.get('/cap-only', c => {
      c.set('userUpstreamIds', ['up-a']);
      collected.capOnly = createGatewayCtxFromHono(c, { wantsStream: false }).upstreamIds;
      return c.text('ok');
    });
    app.get('/both', c => {
      c.set('userUpstreamIds', ['up-a', 'up-b']);
      c.set('apiKeyUpstreamIds', ['up-b', 'up-c']);
      collected.both = createGatewayCtxFromHono(c, { wantsStream: false }).upstreamIds;
      return c.text('ok');
    });
    app.get('/key-only', c => {
      c.set('apiKeyUpstreamIds', ['up-x']);
      collected.keyOnly = createGatewayCtxFromHono(c, { wantsStream: false }).upstreamIds;
      return c.text('ok');
    });
    await app.request('/cap-only');
    await app.request('/both');
    await app.request('/key-only');
    assertEquals(collected.capOnly, ['up-a']);
    assertEquals(collected.both, ['up-b']);
    assertEquals(collected.keyOnly, ['up-x']);
  });

  test('stamps requestStartedAt from performance.now() at construction', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    const before = performance.now();
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      return c.text('ok');
    });
    await app.request('/test');
    const after = performance.now();
    assertExists(ctx);
    if (!(ctx.requestStartedAt >= before && ctx.requestStartedAt <= after)) {
      throw new Error(`requestStartedAt ${ctx.requestStartedAt} not in [${before}, ${after}]`);
    }
  });
});
