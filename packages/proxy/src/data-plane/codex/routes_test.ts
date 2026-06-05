import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from './routes.ts';
import { authMiddleware } from '../../middleware/auth.ts';
import { setupAppTest } from '../../test-helpers.ts';

const buildCodexApp = () => {
  const app = new Hono();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

describe('codex 1p namespace', () => {
  describe('auth', () => {
    it('accepts a floway api key supplied as `Authorization: Bearer <key>`', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/codex/models', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
    });

    it('rejects an unknown bearer with 401', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/codex/models', {
        headers: { authorization: 'Bearer not-a-floway-key' },
      });
      expect(response.status).toBe(401);
    });

    it('rejects requests with no auth header', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/codex/models');
      expect(response.status).toBe(401);
    });
  });

  describe('chatgpt-backend stubs', () => {
    it('serves an empty JWKS so AgentIdentity deployments can opt in later', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ keys: [] });
    });

    it('accepts analytics events and returns 200 so turn metadata is captured locally', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/codex/analytics-events/events', {
        method: 'POST',
        body: JSON.stringify({ events: [] }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
    });

    it.each([
      '/azure-api.codex/plugins/featured',
      '/azure-api.codex/plugins/list',
    ])('serves an empty plugin list at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it.each([
      '/azure-api.codex/ps/plugins/list',
      '/azure-api.codex/ps/plugins/installed',
    ])('serves an empty paginated plugin page at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ plugins: [], pagination: { next_page_token: null } });
    });
  });

  describe('apps MCP server', () => {
    it('answers the JSON-RPC `initialize` handshake with zero-tool capabilities', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
        },
      });
    });

    it('answers `tools/list` with an empty list', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [], nextCursor: null } });
    });
  });

  describe('/codex/models', () => {
    it('returns codex ModelsResponse shape with gpt-5.5 advertised at 1M context', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/codex/models', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { models: { slug: string; context_window?: number; max_context_window?: number; effective_context_window_percent?: number; auto_compact_token_limit?: number | null }[] };
      const gpt55 = body.models.find(m => m.slug === 'gpt-5.5');
      expect(gpt55).toBeDefined();
      expect(gpt55).toMatchObject({
        context_window: 1050000,
        max_context_window: 1050000,
        effective_context_window_percent: 100,
        auto_compact_token_limit: 945000,
      });
    });
  });
});
