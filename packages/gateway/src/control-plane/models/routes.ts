import type { Context } from 'hono';

import { mergeAliasesIntoModels } from '../../data-plane/models/alias-listing.ts';
import { toPublicModel } from '../../data-plane/models/load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../../data-plane/providers/addressable.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { ResolvedModel, UpstreamProviderKind } from '@floway-dev/provider';

// Same DTO as the public /models endpoint, plus one dashboard-only field:
// `upstreams` lists every provider binding for this model as { kind, id, name }
// triples. A single model id can be served by mixed provider kinds (e.g. one
// azure deployment + one custom upstream both expose `gpt-5.5`), so a flat
// `provider`/`upstream_ids` split would misrepresent that. Alias-synthesized
// rows carry an empty list — they do not bind to an upstream directly; their
// targets live under `aliasedFrom`.
interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

interface ControlPlaneModelsResponse extends Omit<PublicModelsResponse, 'data'> {
  data: ControlPlaneModel[];
}

const toControlPlaneModel = (model: ResolvedModel): ControlPlaneModel => ({
  ...toPublicModel(model),
  upstreams: model.providers.map(binding => ({ kind: binding.providerKind, id: binding.upstream, name: binding.upstreamName })),
});

// Wrap an addressable-but-not-listed entry as a control-plane row. The
// canonical metadata (`limits`, `chat`, `endpoints`, `upstreams`) reads
// off the real model the addressable id resolves to; only `id` and
// `display_name` swap in the addressable form so the alias dialog
// combobox renders the actual id the operator can type. `unlisted: true`
// carries the addressability tag through to the dashboard so a future UI
// badge does not need a second registry call.
const toUnlistedControlPlaneModel = (id: string, model: ResolvedModel): ControlPlaneModel => ({
  ...toControlPlaneModel(model),
  id,
  display_name: model.display_name ?? id,
  unlisted: true,
});

export const controlPlaneModels = async (c: Context) => {
  try {
    const includeAliases = c.req.query('aliases') !== 'false';
    const includeUnlisted = c.req.query('include_unlisted') === 'true';
    // Scope the dashboard catalog to the caller's effective upstreams, exactly
    // like the data-plane /models endpoint. On a session request there is no
    // API key, so this resolves to the user's per-user upstream cap: a user who
    // has had an upstream removed must not see its models in the Models tab.
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const [addressable, aliases] = await Promise.all([
      enumerateAddressableModelIds(
        effectiveUpstreamIdsFromContext(c),
        fetcherForUpstream,
        backgroundSchedulerFromContext(c),
      ),
      includeAliases ? getRepo().modelAliases.list() : Promise.resolve([]),
    ]);
    const realModels = listedRealModels(addressable);
    const unlistedRows = includeUnlisted
      ? addressable
          .filter(entry => entry.unlisted === true)
          .map(entry => toUnlistedControlPlaneModel(entry.id, entry.model))
      : [];
    const listedRows = includeAliases
      ? mergeAliasesIntoModels({
          realModels,
          addressableModelIds: addressable,
          aliases,
          mapReal: toControlPlaneModel,
          wrapAlias: entry => ({ ...entry, upstreams: [] }),
        })
      : realModels.map(toControlPlaneModel);
    const data = [...listedRows, ...unlistedRows];
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      data,
    };
    return c.json(response);
  } catch (e: unknown) {
    // Empty-upstreams is a domain state, not an error, on the dashboard. The
    // public /v1/models endpoint still surfaces it as a 502 to remote clients
    // because they need to know the gateway is unconfigured — but the
    // dashboard's Models tab should render an empty grid + the operator
    // guidance message inline instead of flashing a 502 in devtools.
    if (e instanceof Error && e.message.startsWith('No upstream provider configured')) {
      return c.json({ object: 'list', has_more: false, first_id: null, last_id: null, data: [] });
    }
    // Genuine upstream HTTP/parse failures are squashed to a generic 502 so
    // the control plane does not leak provider identity.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error' } }, 502);
  }
};
