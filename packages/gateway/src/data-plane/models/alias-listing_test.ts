import { describe, expect, test } from 'vitest';

import { synthesizeListedAliases } from './alias-listing.ts';
import type { ModelAliasRecord } from '../../repo/types.ts';
import type { AddressableIdEntry } from '../providers/addressable.ts';
import type { ResolvedModel } from '@floway-dev/provider';

const aliasFixture = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  displayName: null,
  visibleInModelsList: true,
  targets: [{ target_model_id: 'gpt-5.4', rules: {} }],
  announcedMetadata: null,
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

const realModel = (overrides: Partial<ResolvedModel> & { id: string }): ResolvedModel => ({
  kind: 'chat',
  limits: {},
  endpoints: { chatCompletions: {}, messages: {}, responses: {} },
  providers: [],
  ...overrides,
});

// Adapt the fixtures' "list of real models" view to the addressable surface
// the synthesizer now consumes — every fixture entry is a listed catalog row.
const listed = (models: readonly ResolvedModel[]): AddressableIdEntry[] =>
  models.map(model => ({ id: model.id, unlisted: undefined, model }));

// Test-only addressable surface that pretends a model is reachable through
// a redirect (e.g. a Copilot variant id). The synthesizer should treat
// such targets as available even though they never appear in the listed
// catalog.
const unlisted = (id: string, model: ResolvedModel): AddressableIdEntry => ({ id, unlisted: true, model });

describe('synthesizeListedAliases', () => {
  test('single-target alias with a pinned reasoning.effort drops the effort block', () => {
    const aliases = [aliasFixture({
      name: 'gpt-fast',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({
      id: 'gpt-5.4',
      display_name: 'GPT 5.4',
      chat: {
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
      },
    })];

    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.id).toBe('gpt-fast');
    expect(entry.display_name).toBe('gpt-5.4 (low effort)');
    // The rule pins effort, so the announced metadata drops it — the
    // caller already knows the value because the alias fixes it.
    expect(entry.chat?.reasoning).toBeUndefined();
    expect(entry.chat?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(entry.aliasedFrom).toEqual({
      name: 'gpt-fast',
      kind: 'chat',
      selection: 'first-available',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    });
  });

  test('single-target alias with a pinned reasoning.budget_tokens drops the budget block', () => {
    const aliases = [aliasFixture({
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { budget_tokens: 4096 } } }],
    })];
    const realModels = [realModel({
      id: 'gpt-5.4',
      chat: { reasoning: { budget_tokens: { min: 1024, max: 65536 } } },
    })];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target alias intersects chat.modalities across every target', () => {
    const aliases = [aliasFixture({
      name: 'smart-router',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.id).toBe('smart-router');
    expect(entry.display_name).toBe('smart-router');
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('multi-target intersection drops capabilities only one target declares', () => {
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low'], default: 'low' } } } }),
      realModel({ id: 'b', chat: {} }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target with an unavailable target intersects over the available subset', () => {
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'gone', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', chat: { modalities: { input: ['text'], output: ['text', 'image'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
    // Every configured target — including the unavailable one — survives in aliasedFrom.
    expect(entry.aliasedFrom?.targets.map(t => t.target_model_id)).toEqual(['a', 'gone', 'b']);
  });

  test('hidden alias is not emitted', () => {
    const aliases = [aliasFixture({ visibleInModelsList: false })];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    expect(synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) })).toEqual([]);
  });

  test('alias whose name collides with a real id is emitted (loadModels drops the duplicate real)', () => {
    const aliases = [aliasFixture({
      name: 'gpt-5.4',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({ id: 'gpt-5.4', display_name: 'GPT 5.4' })];
    const entries = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('gpt-5.4');
    expect(entries[0].aliasedFrom?.name).toBe('gpt-5.4');
  });

  test('no available targets still emits an entry with no chat metadata', () => {
    const aliases = [aliasFixture({
      name: 'orphan',
      targets: [{ target_model_id: 'missing', rules: {} }],
    })];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: [] });
    expect(entry.id).toBe('orphan');
    expect(entry.display_name).toBe('missing');
    expect(entry.chat).toBeUndefined();
    expect(entry.cost).toBeUndefined();
    expect(entry.aliasedFrom?.targets).toEqual([{ target_model_id: 'missing', rules: {} }]);
  });

  test('sorts entries by (sort_order, name) so listing order stays stable', () => {
    const aliases = [
      aliasFixture({ name: 'late', sortOrder: 1 }),
      aliasFixture({ name: 'mid-a', sortOrder: 0 }),
      aliasFixture({ name: 'mid-b', sortOrder: 0 }),
    ];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    const ids = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) }).map(entry => entry.id);
    expect(ids).toEqual(['mid-a', 'mid-b', 'late']);
  });

  test('targets whose kind disagrees with the alias are not counted as available', () => {
    const aliases = [aliasFixture({
      kind: 'chat',
      targets: [
        { target_model_id: 'emb', rules: {} },
        { target_model_id: 'chat', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'emb', kind: 'embedding' }),
      realModel({ id: 'chat', chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    // Only the chat target backs the metadata — the embedding row never
    // enters the intersection / narrowing path.
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('operator-set display_name wins over the derived form', () => {
    const aliases = [aliasFixture({
      displayName: 'My Fast GPT',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.display_name).toBe('My Fast GPT');
  });

  test('multi-target alias whose first target pins reasoning.effort drops the alias-wide effort block', () => {
    // The pinned target counts as unsupported for effort, so the
    // intersection collapses — effort never makes it onto the listing.
    const aliases = [aliasFixture({
      name: 'mixed',
      targets: [
        { target_model_id: 'a', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
      realModel({ id: 'b', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target alias without rules intersects reasoning.effort across targets', () => {
    const aliases = [aliasFixture({
      name: 'unfixed',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
      realModel({ id: 'b', chat: { reasoning: { effort: { supported: ['medium', 'high'], default: 'medium' } } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.reasoning?.effort).toEqual({ supported: ['medium', 'high'], default: 'medium' });
  });

  test('rules.reasoning.adaptive=true at any target drops adaptive from the announced metadata', () => {
    const aliases = [aliasFixture({
      name: 'pinned-adaptive',
      targets: [
        { target_model_id: 'a', rules: { reasoning: { adaptive: true } } },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { adaptive: true } } }),
      realModel({ id: 'b', chat: { reasoning: { adaptive: true } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('limits intersection emits min across targets; absent when any target lacks the field', () => {
    const aliases = [aliasFixture({
      name: 'multi-limits',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', limits: { max_context_window_tokens: 128000, max_output_tokens: 16000 } }),
      realModel({ id: 'b', limits: { max_context_window_tokens: 200000 } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    // Both targets advertise max_context_window_tokens — emit the min.
    expect(entry.limits.max_context_window_tokens).toBe(128000);
    // Only `a` declares max_output_tokens, so it drops out.
    expect(entry.limits.max_output_tokens).toBeUndefined();
  });

  test('operator override pins limits.max_output_tokens; chat falls back to computed intersection', () => {
    const aliases = [aliasFixture({
      name: 'overridden',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
      announcedMetadata: {
        limits: { max_output_tokens: 8192 },
      },
    })];
    const realModels = [
      realModel({ id: 'a', limits: { max_context_window_tokens: 128000 }, chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', limits: { max_context_window_tokens: 200000 }, chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    // The override carries the operator's pinned ceiling verbatim …
    expect(entry.limits).toEqual({ max_output_tokens: 8192 });
    // … while chat falls back to the rule-aware intersection.
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('operator override fully replaces chat when set, regardless of computed', () => {
    const aliases = [aliasFixture({
      name: 'chat-override',
      targets: [{ target_model_id: 'a', rules: {} }],
      announcedMetadata: {
        chat: { modalities: { input: ['text'], output: ['text'] } },
      },
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.chat).toEqual({ modalities: { input: ['text'], output: ['text'] } });
  });

  test('endpoints is the union across available targets — every reachable endpoint surfaces', () => {
    const aliases = [aliasFixture({
      name: 'mixed',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      // Target a serves the three chat endpoints + /completions.
      realModel({ id: 'a', endpoints: { chatCompletions: {}, messages: {}, responses: {}, completions: {} } }),
      // Target b only serves the three chat endpoints.
      realModel({ id: 'b', endpoints: { chatCompletions: {}, messages: {}, responses: {} } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    // Union: every key surfaces. Resolver narrows to the supporting subset
    // at request time, so first-available / random stays sound per-endpoint.
    expect(entry.endpoints).toEqual({
      chatCompletions: {},
      messages: {},
      responses: {},
      completions: {},
    });
  });

  test('endpoints union surfaces both image keys when targets split between generations and edits', () => {
    const aliases = [aliasFixture({
      kind: 'image',
      targets: [
        { target_model_id: 'gen', rules: {} },
        { target_model_id: 'edit', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'gen', kind: 'image', endpoints: { imagesGenerations: {} } }),
      realModel({ id: 'edit', kind: 'image', endpoints: { imagesEdits: {} } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: listed(realModels) });
    expect(entry.endpoints).toEqual({ imagesGenerations: {}, imagesEdits: {} });
  });

  test('endpoints is an empty map on the entry when no target is currently available', () => {
    const aliases = [aliasFixture({
      name: 'ghost',
      targets: [{ target_model_id: 'missing', rules: {} }],
    })];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds: [] });
    expect(entry.endpoints).toEqual({});
  });

  test('an alias target reachable only via the addressable-but-not-listed surface counts as available', () => {
    // A Copilot variant id like `claude-opus-4.7-high` collapses to the
    // canonical public id `claude-opus-4-7` at the resolver layer. The
    // listing now reads from the same addressable surface, so an alias
    // that targets the variant id resolves to the canonical model and the
    // synthesized entry inherits its catalog metadata.
    const canonical = realModel({
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
    });
    const aliases = [aliasFixture({
      name: 'fast-claude',
      targets: [{ target_model_id: 'claude-opus-4.7-high', rules: {} }],
    })];
    const addressableModelIds = [
      ...listed([canonical]),
      unlisted('claude-opus-4.7-high', canonical),
    ];
    const [entry] = synthesizeListedAliases({ aliases, addressableModelIds });
    expect(entry.id).toBe('fast-claude');
    expect(entry.chat?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(entry.endpoints).toEqual({ chatCompletions: {}, messages: {}, responses: {} });
  });
});
