# Model Resolution

This document describes how the gateway turns an inbound `model` string into a
provider candidate the dispatch layer can call. Three concerns are kept apart:

- **Catalog assembly** — every enabled upstream's catalog is collapsed into
  one gateway-wide list of public model ids keyed by public id, with a
  reverse index of which upstream instances expose each id.
- **Resolution** — an inbound `model` string is matched against the catalog
  to produce a flat list of `(provider, model)` candidates, kind-filtered
  against the inbound endpoint kind. This step never inspects per-endpoint
  capabilities.
- **Endpoint selection** — when a candidate is actually dispatched, the
  attempt layer reads `model.endpoints` and picks a target protocol from
  its inbound-protocol preference table. A candidate that cannot serve the
  current operation falls over to the next candidate.

## Catalog Assembly

Inputs: the operator's enabled upstreams (filtered to the caller's effective
scope when one is set), each upstream's SWR-cached `getProvidedModels`
output, and each upstream's `modelPrefix` policy.

For every upstream model entry, one or more catalog entries are emitted:

- If the upstream has no `modelPrefix`, one entry is emitted at the model's
  bare id.
- If the upstream has a `modelPrefix` with `listed` surfaces, one entry is
  emitted per surface (`unprefixed`, `prefixed`, or both). The prefixed
  surface clones the upstream model with the rewritten id and synthesizes
  `display_name: "<upstreamName>: <originalName>"` so the dashboard tells
  the operator which upstream a prefixed id came from. `providerData` is
  preserved by the clone — the per-provider wire-call still reads the
  real upstream model id from there.

Operator-disabled public ids vanish for that upstream before the entries
are emitted, so a disabled `gpt-4o` hides both `gpt-4o` and
`<prefix>gpt-4o` from the upstream's contribution. The disable does not
cascade to other upstreams.

When two upstreams emit an entry under the same public id, the first wins
for metadata and the later one **endpoint-unions** into it. The merged
`endpoints` is the OR of the participants' endpoint capability flags, and
`kind` is recomputed from the union. Runtime dispatch still uses each
upstream's own `UpstreamModel`, so capability-sensitive calls do not
depend on the merged view.

Catalog assembly returns two artefacts together:

- `models: CatalogModel[]` — public-id-keyed metadata (`InternalModel`
  fields plus the merged `endpoints`). `toPublicModel` projects each row
  onto the wire DTO at `/v1/models` and `/models`.
- `upstreamsByPublicId: Map<string, ModelProviderInstance[]>` — every
  upstream instance that emitted an entry under the given public id, in
  enumeration order. Resolution reads this to know which upstreams can
  serve a given inbound id without re-walking the catalog.

Output ordering: the public-facing list is sorted by `compareModelIds`
before it crosses any gateway boundary — `/v1/models`, `/models`,
`/v1beta/models`, and the control-plane catalog endpoint.

Failed-upstream surfacing: a catalog fetch that rejects with `AbortError`
propagates so the per-request abort signal cannot be masked by a slow
upstream. Any other rejection is captured into the assembly's
`failedUpstreams: string[]`, which the per-request resolver later inlines
into 404 / 400 wording so the client sees parenthetical names of the
upstreams whose catalog was unreachable this round.

## Addressable Surfaces

`modelPrefix.addressable` controls which inbound id forms an upstream
**accepts** at resolution time, independent of which forms it `listed` at
catalog assembly time:

- `[unprefixed]` — the inbound id is looked up verbatim against the
  upstream's catalog.
- `[prefixed]` — the inbound id is accepted only if it starts with the
  configured prefix, and the lookup uses `inbound.slice(prefix.length)`.
- `[unprefixed, prefixed]` — both interpretations are tried; the
  unprefixed interpretation is enumerated first, so when both succeed the
  bare lookup wins ordering ties.

A single inbound id can therefore produce **two interpretations against
the same upstream** when both surfaces are addressable and the inbound id
literally starts with the configured prefix. Each interpretation is its
own catalog lookup and yields its own candidate; no deduplication is
performed.

An upstream with no `modelPrefix` is implicitly fully unprefixed.

## Resolution

The per-request resolver runs once at the data-plane entry point and
produces the candidate list every dispatch layer reads.

Inputs:

- `model` — the inbound id verbatim as the client sent it.
- `upstreamIds` — the caller's effective upstream cap (`null` =
  unrestricted; empty list = no providers visible). The cap is the
  intersection of per-user and per-api-key allow-lists; unknown ids raise
  a configuration error rather than silently narrowing.
- `inboundKind` — `chat` / `embedding` / `image` / `completion`,
  determined by the inbound endpoint, not by the inbound payload.

Steps:

1. **List the visible providers** through `listModelProviders(upstreamIds)`
   in configured `sort_order`. Empty list → throw a
   "no upstream provider configured" error before any lookup.
2. **Enumerate interpretations** for the inbound id across the visible
   providers (Addressable Surfaces above). One inbound id expands into
   zero, one, or two interpretations per provider.
3. **Resolve each interpretation** against the upstream's SWR-cached
   catalog. Resolution is a single exact match — `find(model.id ===
   lookupId && !disabled.has(model.id))`. Providers contribute no
   normalization hook above the catalog; an upstream that wants the
   gateway to accept a non-listed alternate id must list it in its
   catalog.
4. **Kind-filter** the resolved set: keep only entries whose
   `model.kind === inboundKind`. No endpoint-level capability check
   happens here.
5. If the resolved set is non-empty, return the candidates plus
   `sawModel: true` and `failedUpstreams`.
6. If the resolved set is empty **and** the inbound id matches `-\d{8}$`,
   strip the eight-digit dated suffix and rerun steps 2–5 once against
   the stripped id. The retry is bounded to one iteration; a second
   dated suffix on the stripped id is not stripped again.
7. If both attempts produce zero candidates, return `sawModel:
   false` with the union of `failedUpstreams` seen across the
   attempts. The caller renders a 404 / 400 with the standard wording
   plus the failed-upstreams parenthetical.

The dated-suffix fallback exists for clients that pin to a vendor's dated
release id (typical for Anthropic-style `claude-sonnet-4-5-20250929`)
against a catalog that only lists the base id. It deliberately operates
on the **full resolution flow**, not on a single upstream's catalog, so
the stripped id is tried against every visible upstream in its own
enumeration order.

The resolver never mutates the inbound id on the request body. The
returned candidates carry the actual `UpstreamModel` (with its own `id`
and `providerData`), and the dispatch layer reads from there.

## Candidate Shape

```ts
interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly model: UpstreamModel;
  readonly fetcher: Fetcher;
}
```

- `provider` is the resolved upstream provider instance — every wire call,
  capability flag, and pricing lookup reads off it directly. Fields the
  candidate used to copy (upstream id, upstream name, provider kind,
  `supportsResponsesItemReference`) are read from `provider.*`.
- `model` is the specific `UpstreamModel` entry that the catalog match
  produced for this upstream. Its `id` is the upstream's catalog id;
  `providerData` carries the per-provider wire id; `enabledFlags` carries
  the operator's per-binding flag set. Same fields the candidate used to
  copy off `binding.enabledFlags` / `binding.upstreamModel` are read from
  `model.*`.
- `fetcher` is the per-request proxy-chain-bound `Fetcher` for the
  candidate's upstream, minted once at resolution time and shared by every
  attempt that dispatches against this candidate.

A target protocol (e.g. `messages` / `responses` / `chat-completions`) is
deliberately **not** part of the candidate — see Endpoint Selection.

## Endpoint Selection

Resolution returns kind-matched candidates without consulting
`model.endpoints`. The actual target endpoint is chosen at attempt
dispatch, by a per-inbound-operation preference table that lives next to
the attempt code:

- `/v1/messages` generate: `messages` > `responses` > `chat-completions`.
- `/v1/messages` countTokens: `messages` only.
- `/v1/responses` generate: `responses` > `messages` > `chat-completions`.
- `/v1/responses/compact`: `responses` only.
- `/v1/chat/completions`: `chat-completions` > `messages` > `responses`.
- `/v1beta/models/{m}:generateContent` and `:streamGenerateContent`:
  `chat-completions` > `messages` > `responses` (Gemini is always served
  via translation).
- `/v1beta/models/{m}:countTokens`: `messages` only.

Each table picks the first entry whose flag is set on
`candidate.model.endpoints`. The result is the target protocol the attempt
dispatches on for that candidate (native call or translation, as the
TRANSLATION document specifies).

A picker returning `null` means the candidate cannot serve the current
operation. Attempt treats this exactly like an attempt-level failure —
control falls to the next candidate in the planner's ordering. The same
failover path handles upstream-side rejection of a candidate that the
picker accepted; the only difference is that null-pick failover happens
before any wire call.

Passthrough endpoints (`/v1/embeddings`, `/v1/images/*`, `/v1/completions`)
follow the same rule with a single-key predicate
(`endpoints[endpointKey] !== undefined`) instead of a multi-target
preference list. The kind-filter at resolution time guarantees a
chat-kind candidate is never offered to a passthrough endpoint and vice
versa; the endpoint-key check at attempt time then narrows within the
kind.

## Failover Ordering

Candidates are ordered before they reach the attempt loop:

- Across upstreams, by configured `sort_order` (lower first). An upstream
  with an explicit `sort_order` ahead of another upstream's gets first
  shot at the inbound id.
- Within a single upstream, the unprefixed interpretation precedes the
  prefixed one when both apply.

For Responses-shape inbound, a planner pass adjusts the ordering by
stored-item affinity before the attempt loop sees it (see the Responses
items affinity module). The planner reads
`provider.supportsResponsesItemReference` to decide whether a candidate
can absorb an unexpanded `item_reference` carrier and rejects a request
that names a forcing upstream the candidate list does not include. The
planner never invents new candidates; it only narrows or re-orders the
list the resolver produced.

The attempt loop walks the ordered list and stops at the first attempt
that returns a terminal answer — events, an upstream-shaped API error,
or an internal-debug failure are all terminal. Only the null-endpoint-
pick case and the planner-rejected-but-not-forced cases fall through to
the next candidate.

## Known Edges

- A catalog that disabled the inbound id under one upstream still serves
  it from another that allows it; the operator's per-upstream disable
  list is intentionally not cross-cutting.
- A `-\d{8}$` strip is the only inbound-id normalization the gateway
  applies. Vendor variant suffixes (effort tiers, context-window
  variants, fast-mode) are routed by request-body fields against a
  catalog that lists only the base id; clients that send raw variant ids
  receive a model-missing 404 unless their inbound id happens to match
  another upstream's catalog entry verbatim.
- The catalog is SWR-cached per upstream. A model the operator just
  enabled is visible to resolution as soon as the next cached refresh
  lands; SWR-soft hits do not block the request.
- Dual-addressable surfaces (`[unprefixed, prefixed]`) intentionally
  retain both candidate paths instead of deduping. A request that
  resolves through both surfaces of the same upstream will attempt the
  bare lookup first, then the prefix-stripped lookup if the first
  attempt fell over.
