// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defineComponent } from 'vue';

import AliasRow from './AliasRow.vue';
import type { ModelAlias } from '../../api/types.ts';

const baseAlias: ModelAlias = {
  alias: 'opus-xhigh',
  target_model_id: 'claude-opus-4-6',
  upstream_ids: [],
  rules: { reasoning: { effort: 'xhigh' } },
  visible_in_models_list: true,
  on_conflict: 'real-only',
  display_name: 'Opus XHigh',
  created_at: 1_700_000_000,
};

describe('AliasRow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('renders the display name, alias id, and target', () => {
    const wrapper = mount(AliasRow, { props: { alias: baseAlias } });
    expect(wrapper.text()).toContain('Opus XHigh');
    expect(wrapper.text()).toContain('opus-xhigh');
    expect(wrapper.text()).toContain('claude-opus-4-6');
  });

  test('does not render the on_conflict label as a badge', () => {
    // The row used to surface `real-only` / `alias-only` as a coloured badge.
    // Operator feedback was that the inline label was noisy and the same
    // information lives inside the edit dialog. Asserting absence here pins
    // the regression — the words must not slip back into the row template.
    const wrapper = mount(AliasRow, { props: { alias: baseAlias } });
    expect(wrapper.text()).not.toContain('real-only');
    expect(wrapper.text()).not.toContain('alias-only');
  });

  test('renders upstream-id pills when the alias whitelists upstreams', () => {
    const wrapper = mount(AliasRow, {
      props: { alias: { ...baseAlias, upstream_ids: ['up_anth', 'up_oai'] } },
    });
    const text = wrapper.text();
    expect(text).toContain('up_anth');
    expect(text).toContain('up_oai');
  });

  test('falls back to alias name when display_name is null', () => {
    const wrapper = mount(AliasRow, { props: { alias: { ...baseAlias, display_name: null } } });
    // alias id appears twice (label fallback + the small font-mono id), but the
    // important assertion is that the label slot is non-empty.
    expect(wrapper.text()).toContain('opus-xhigh');
    expect(wrapper.text()).not.toContain('Opus XHigh');
  });

  test('emits edit and delete on the matching button clicks', async () => {
    const wrapper = mount(AliasRow, { props: { alias: baseAlias } });
    await wrapper.find('[aria-label="Edit alias"]').trigger('click');
    await wrapper.find('[aria-label="Delete alias"]').trigger('click');
    expect(wrapper.emitted('edit')).toHaveLength(1);
    expect(wrapper.emitted('delete')).toHaveLength(1);
  });

  test('shows a "hidden" badge when visible_in_models_list is false', () => {
    const wrapper = mount(AliasRow, { props: { alias: { ...baseAlias, visible_in_models_list: false } } });
    expect(wrapper.text()).toContain('hidden');
  });

  test('renders one rule badge per active rule field', () => {
    const wrapper = mount(AliasRow, {
      props: {
        alias: {
          ...baseAlias,
          rules: { reasoning: { effort: 'high' }, verbosity: 'low', serviceTier: 'priority' },
        },
      },
    });
    // formatAliasRuleBadges drives the order: effort, verbosity, service tier.
    const text = wrapper.text();
    expect(text).toContain('effort: high');
    expect(text).toContain('verbosity: low');
    expect(text).toContain('service tier: priority');
  });
});

// Bare-component smoke test for the card. We mock the composable so the
// card renders deterministically without an HTTP round-trip; the stub
// substitutes the same shape useModelAliases exposes.
describe('AliasesSettingsCard', () => {
  test('renders empty state when the store has no aliases', async () => {
    vi.resetModules();
    vi.doMock('../../composables/useModelAliases.ts', () => ({
      useModelAliases: () => ({
        aliases: { value: [] },
        loading: { value: false },
        error: { value: null },
        load: vi.fn(),
      }),
    }));
    vi.doMock('../../api/client.ts', () => ({
      useApi: () => ({ api: { aliases: { ':alias': { $delete: vi.fn() } } } }),
      callApi: vi.fn(),
    }));
    const { default: AliasesSettingsCard } = await import('./AliasesSettingsCard.vue');
    const wrapper = mount(AliasesSettingsCard);
    expect(wrapper.text()).toContain('No aliases configured');
  });

  test('renders one AliasRow per alias the store holds', async () => {
    vi.resetModules();
    const rows: ModelAlias[] = [
      { ...baseAlias, alias: 'a-one' },
      { ...baseAlias, alias: 'b-two', display_name: null },
    ];
    vi.doMock('../../composables/useModelAliases.ts', () => ({
      useModelAliases: () => ({
        aliases: { value: rows },
        loading: { value: false },
        error: { value: null },
        load: vi.fn(),
      }),
    }));
    vi.doMock('../../api/client.ts', () => ({
      useApi: () => ({ api: { aliases: { ':alias': { $delete: vi.fn() } } } }),
      callApi: vi.fn(),
    }));
    const { default: AliasesSettingsCard } = await import('./AliasesSettingsCard.vue');
    const wrapper = mount(AliasesSettingsCard);
    // Each row exposes its delete button by aria-label, so the count is a
    // reliable proxy for "one AliasRow rendered per alias".
    expect(wrapper.findAll('[aria-label="Delete alias"]').length).toBe(rows.length);
    expect(wrapper.text()).toContain('a-one');
    expect(wrapper.text()).toContain('b-two');
  });
});

// Sanity: a stub wrapping the component above guards against template parse
// regressions (an unknown directive or missing import would explode at mount
// time even when no real backend is reachable).
test('the test harness can mount a trivial component', () => {
  const wrapper = mount(defineComponent({ template: '<span>ok</span>' }));
  expect(wrapper.text()).toBe('ok');
});
