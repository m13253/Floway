import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals } from '../../../../test-assert.ts';
import { copilotModels, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../../../test-helpers.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';

// Compaction is a registered endpoint, but no upstream advertises
// `responses_compact` yet (its upstream realization is a separate effort), so a
// known model resolves and then reports the endpoint as unsupported. This locks
// the route wiring and the gating contract.
test('/v1/responses/compact reports not-supported until an upstream realizes it', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    req => {
      const url = new URL(req.url);
      if (url.hostname === 'api.github.com') {
        return jsonResponse({ token: 'fake-copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 });
      }
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-5', supported_endpoints: ['/responses'] }]));
      }
      throw new Error(`unexpected upstream call: ${url.pathname}`);
    },
    async () => {
      const response = await requestApp('/v1/responses/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-5', input: [{ role: 'user', content: 'hello' }] }),
      });

      assertEquals(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assertEquals(body.error.message.includes('does not support the /responses/compact endpoint'), true);
    },
  );

  clearModelsStore();
  await clearCopilotTokenCache();
});
