import { describe, expect, test } from 'vitest';

import { enumerateAddressableModelIds } from './addressable.ts';
import { clearInFlightForTesting } from './models-cache.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, setupAppTest } from '../../test-helpers.ts';
import { directFetcher } from '@floway-dev/provider';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const noBackground = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

describe('enumerateAddressableModelIds', () => {
  test('returns the listed catalog as listed entries when no provider contributes addressable-only forms', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord());
    clearInFlightForTesting();

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'shared-model', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        expect(surface.entries.map(e => ({ id: e.id, unlisted: e.unlisted }))).toEqual([
          { id: 'shared-model', unlisted: undefined },
        ]);
      },
    );
  });

  test('emits the addressable-only prefix form whenever modelPrefix.addressable ⊋ modelPrefix.listed', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_custom_prefixed',
      // Listed only as `cust/gpt-5.4`, but the bare `gpt-5.4` form remains
      // addressable for clients that still talk to the upstream by its raw
      // public id.
      modelPrefix: { prefix: 'cust/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));
    clearInFlightForTesting();

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        const byId = new Map(surface.entries.map(e => [e.id, e]));
        expect(byId.get('cust/gpt-5.4')?.unlisted).toBeUndefined();
        expect(byId.get('gpt-5.4')?.unlisted).toBe(true);
        // The addressable-only entry still resolves to the same `ResolvedModel`
        // as the canonical listed id, so consumers find one consistent row.
        expect(byId.get('gpt-5.4')?.model).toBe(byId.get('cust/gpt-5.4')?.model);
      },
    );
  });

  test('Copilot variant ids surface as addressable-but-not-listed entries pointing at the canonical public model', async () => {
    const { repo, githubAccount } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCopilotUpstreamRecord(githubAccount));
    clearInFlightForTesting();

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
        if (url.pathname === '/copilot_internal/v2/token') {
          return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
        }
        if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
          return jsonResponse(copilotModels([
            { id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] },
            { id: 'claude-opus-4.7-high', supported_endpoints: ['/v1/messages'] },
          ]));
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const surface = await enumerateAddressableModelIds(null, () => directFetcher, noBackground);
        const byId = new Map(surface.entries.map(e => [e.id, e]));
        // The canonical merged id is the listed entry.
        expect(byId.get('claude-opus-4-7')?.unlisted).toBeUndefined();
        // Both raw variants are addressable-but-not-listed, redirecting to
        // the canonical model.
        expect(byId.get('claude-opus-4.7')?.unlisted).toBe(true);
        expect(byId.get('claude-opus-4.7-high')?.unlisted).toBe(true);
        expect(byId.get('claude-opus-4.7')?.model).toBe(byId.get('claude-opus-4-7')?.model);
      },
    );
  });

  test('throws "no upstream configured" when the upstream cap is empty — surfacing the same hint /v1/models has always raised', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    clearInFlightForTesting();

    await expect(enumerateAddressableModelIds(null, () => directFetcher, noBackground))
      .rejects.toThrow('No upstream provider configured');
  });
});
