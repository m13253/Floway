import { describe, test } from 'vitest';
import { Hono } from 'hono';

import { assertEquals, assertExists } from '@floway-dev/test-utils';
import { createGatewayCtxFromHono, createGatewayCtxForWs } from './gateway-ctx.ts';

const makeHonoContext = (vars: Record<string, unknown> = {}) => {
  const app = new Hono();
  let capturedCtx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
  app.get('/test', c => {
    for (const [k, v] of Object.entries(vars)) c.set(k, v);
    capturedCtx = createGatewayCtxFromHono(c, false);
    return c.text('ok');
  });
  return { app, getCaptured: () => capturedCtx! };
};

describe('createGatewayCtxFromHono', () => {
  test('copies auth fields when both are set', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      c.set('apiKeyId', 'key-1');
      c.set('apiKeyUpstreamIds', ['up-1', 'up-2']);
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'key-1');
    assertEquals(ctx.apiKeyUpstreamIds, ['up-1', 'up-2']);
  });

  test('sets apiKeyId and apiKeyUpstreamIds to null when unset (admin key path)', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, null);
    assertEquals(ctx.apiKeyUpstreamIds, null);
  });

  test('assembles a mutable Headers instance', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.headers);
    // Must be mutable: can append without throwing
    ctx.headers.append('x-test', 'value');
    assertEquals(ctx.headers.get('x-test'), 'value');
  });

  test('respects wantsStream=true', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('respects wantsStream=false', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, false);
  });

  test('wantsStream=true: downstreamAbortController is defined and abortSignal matches its signal', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.downstreamAbortController);
    assertEquals(ctx.abortSignal, ctx.downstreamAbortController.signal);
  });

  test('wantsStream=false: downstreamAbortController and abortSignal are both undefined', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.downstreamAbortController, undefined);
    assertEquals(ctx.abortSignal, undefined);
  });
});

describe('createGatewayCtxForWs', () => {
  test('copies auth fields from Hono context', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      c.set('apiKeyId', 'ws-key');
      c.set('apiKeyUpstreamIds', ['ws-up-1']);
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'ws-key');
    assertEquals(ctx.apiKeyUpstreamIds, ['ws-up-1']);
  });

  test('sets apiKeyId and apiKeyUpstreamIds to null when unset', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, null);
    assertEquals(ctx.apiKeyUpstreamIds, null);
  });

  test('assembles a mutable Headers instance', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.headers);
    ctx.headers.append('x-ws-test', 'value');
    assertEquals(ctx.headers.get('x-ws-test'), 'value');
  });

  test('forces wantsStream=true', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('sets abortSignal from downstreamAbortController.signal', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.abortSignal, controller.signal);
  });

  test('exposes downstreamAbortController', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.downstreamAbortController, controller);
  });
});
