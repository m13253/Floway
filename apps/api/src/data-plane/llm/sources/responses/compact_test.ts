import { expect, test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals } from '../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, requestApp, setupAppTest, sseResponsesResponse, withMockedFetch } from '../../../../test-helpers.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';

interface CompactionResult {
  object: string;
  output: { type: string; id?: string; encrypted_content?: string }[];
}

const userInput = [{ role: 'user', content: 'summarize our chat' }];

// Native passthrough: an upstream advertising `responses.compact` answers
// `/responses/compact` directly with a `response.compaction` body. The gateway
// re-mints the output item ids (so the compaction blob persists with upstream
// affinity) and returns the same envelope.
test('/v1/responses/compact passes through a native compaction', async () => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  // Isolate the custom upstream — a disabled copilot is skipped by the provider
  // walk, so no Copilot /models fetch interferes with this native path.
  await repo.upstreams.save({ ...copilotUpstream, enabled: false });
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_native_compact',
    config: {
      baseUrl: 'https://native.example.com',
      bearerToken: 'sk-native',
      authStyle: 'bearer',
      supportedEndpoints: ['/responses'],
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'native-compactor', kind: 'chat', supportedEndpoints: ['/responses'], responses: { compact: true } }],
    },
  }));

  await withMockedFetch(
    req => {
      const url = new URL(req.url);
      if (url.hostname === 'native.example.com' && url.pathname === '/v1/responses/compact') {
        return jsonResponse({
          id: 'resp_compaction_1',
          object: 'response.compaction',
          created_at: 1717000000,
          output: [
            { type: 'message', id: 'msg_upstream_1', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'summarize our chat' }] },
            { type: 'compaction', id: 'cmp_upstream_1', encrypted_content: 'gAAAAAnative-blob' },
          ],
          usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 },
        });
      }
      throw new Error(`unexpected upstream call: ${url.hostname}${url.pathname}`);
    },
    async () => {
      const response = await requestApp('/v1/responses/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'native-compactor', input: userInput }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as CompactionResult;
      assertEquals(body.object, 'response.compaction');
      const compaction = body.output.find(item => item.type === 'compaction');
      expect(compaction).toBeDefined();
      assertEquals(compaction?.encrypted_content, 'gAAAAAnative-blob');
      // The upstream id is re-minted to a gateway stored id so next-turn routing
      // binds the producing upstream.
      expect(compaction?.id?.startsWith('cmp_')).toBe(true);
      assertEquals(compaction?.id === 'cmp_upstream_1', false);
      // The retained user message survives the passthrough.
      expect(body.output.some(item => item.type === 'message')).toBe(true);
    },
  );

  clearModelsStore();
  await clearCopilotTokenCache();
});

// context_management realization: an upstream that only honours the parameter
// (Copilot gpt-5.x) runs a `/responses` generation, and the gateway keeps only
// the compaction output item — the discarded assistant turn is dropped — and
// rewraps it under the `response.compaction` envelope.
test('/v1/responses/compact realizes compaction via context_management', async () => {
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
      if (url.pathname === '/responses') {
        return sseResponsesResponse({
          id: 'resp_cm_1',
          object: 'response',
          model: 'gpt-5',
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [
            { type: 'message', id: 'msg_assistant_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'discarded turn' }] },
            { type: 'compaction', id: 'cmp_upstream_cm', encrypted_content: 'gAAAAAcm-blob' },
          ],
          usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
        });
      }
      throw new Error(`unexpected upstream call: ${url.hostname}${url.pathname}`);
    },
    async () => {
      const response = await requestApp('/v1/responses/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-5', input: userInput }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as CompactionResult;
      assertEquals(body.object, 'response.compaction');
      // Only the compaction item is retained; the generated assistant message
      // is dropped.
      assertEquals(body.output.length, 1);
      assertEquals(body.output[0]?.type, 'compaction');
      assertEquals(body.output[0]?.encrypted_content, 'gAAAAAcm-blob');
      expect(body.output[0]?.id?.startsWith('cmp_')).toBe(true);
    },
  );

  clearModelsStore();
  await clearCopilotTokenCache();
});

// A Responses model advertising neither compaction sub-capability resolves and
// then reports the endpoint as unsupported — the routing gate, not a fallback.
test('/v1/responses/compact reports not-supported when no compaction capability', async () => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  await repo.upstreams.save({ ...copilotUpstream, enabled: false });
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_plain_responses',
    config: {
      baseUrl: 'https://plain.example.com',
      bearerToken: 'sk-plain',
      authStyle: 'bearer',
      supportedEndpoints: ['/responses'],
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'plain-responses', kind: 'chat', supportedEndpoints: ['/responses'] }],
    },
  }));

  await withMockedFetch(
    req => {
      throw new Error(`unexpected upstream call: ${new URL(req.url).pathname}`);
    },
    async () => {
      const response = await requestApp('/v1/responses/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'plain-responses', input: userInput }),
      });

      assertEquals(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assertEquals(body.error.message.includes('does not support the /responses/compact endpoint'), true);
    },
  );

  clearModelsStore();
  await clearCopilotTokenCache();
});
