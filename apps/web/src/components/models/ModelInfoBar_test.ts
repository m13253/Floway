// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';

import ModelInfoBar from './ModelInfoBar.vue';
import type { ControlPlaneModel } from '../../api/types.ts';

const realModel: ControlPlaneModel = {
  id: 'gpt-5.4',
  display_name: 'GPT-5.4',
  kind: 'chat',
  limits: { max_context_window_tokens: 200_000, max_output_tokens: 16_384 },
  upstreams: [{ id: 'up_oai', kind: 'custom', name: 'OpenAI' }],
};

const aliasModel: ControlPlaneModel = {
  id: 'codex-auto-review',
  display_name: 'Codex Auto Review',
  kind: 'chat',
  limits: { max_context_window_tokens: 200_000, max_output_tokens: 16_384 },
  upstreams: [{ id: 'up_oai', kind: 'custom', name: 'OpenAI' }],
  aliasedFrom: {
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: { reasoning: { effort: 'low' } },
    onConflict: 'real-only',
    displayName: 'Codex Auto Review',
  },
};

describe('ModelInfoBar', () => {
  describe('real-model row (no aliasedFrom)', () => {
    test('renders the display-name heading + upstream + limit badges', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: realModel } });
      const text = wrapper.text();
      expect(text).toContain('GPT-5.4');
      expect(text).toContain('OpenAI');
      expect(text).toContain('context:');
      expect(text).toContain('output:');
    });

    test('does not render the alias-prose summary line', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: realModel } });
      // The phrase "low effort" is uniquely produced by the alias path; its
      // absence on a real-model row guards against the alias branch leaking.
      expect(wrapper.text()).not.toContain('low effort');
      expect(wrapper.text()).not.toContain('→');
    });
  });

  describe('alias row', () => {
    test('renders the operator-set displayName as a heading when present', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: aliasModel } });
      const headings = wrapper.findAll('h3');
      expect(headings).toHaveLength(1);
      expect(headings[0].text()).toBe('Codex Auto Review');
    });

    test('omits the heading when displayName is missing', () => {
      const without: ControlPlaneModel = {
        ...aliasModel,
        aliasedFrom: { ...aliasModel.aliasedFrom!, displayName: undefined },
      };
      const wrapper = mount(ModelInfoBar, { props: { model: without } });
      expect(wrapper.findAll('h3')).toHaveLength(0);
    });

    test('renders the id mapping with the alias id emphasised and target muted', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: aliasModel } });
      const aliasSpan = wrapper.get('.text-white.break-all');
      const targetSpan = wrapper.get('.text-gray-500.break-all');
      expect(aliasSpan.text()).toBe('codex-auto-review');
      expect(targetSpan.text()).toBe('gpt-5.4');
      // The arrow lives between them.
      expect(wrapper.text()).toContain('→');
    });

    test('renders the rules summary on a third line when rules apply', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: aliasModel } });
      const paragraphs = wrapper.findAll('p');
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[1].text()).toBe('low effort');
      expect(paragraphs[1].classes()).toContain('text-xs');
      expect(paragraphs[1].classes()).toContain('text-gray-500');
    });

    test('omits the rules summary line when no rule applies', () => {
      const empty: ControlPlaneModel = {
        ...aliasModel,
        aliasedFrom: { ...aliasModel.aliasedFrom!, rules: {} },
      };
      const wrapper = mount(ModelInfoBar, { props: { model: empty } });
      expect(wrapper.findAll('p')).toHaveLength(1);
    });

    test('drops the upstream and limit badges that the real-model path renders', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: aliasModel } });
      const text = wrapper.text();
      expect(text).not.toContain('OpenAI');
      expect(text).not.toContain('context:');
      expect(text).not.toContain('output:');
    });

    test('keeps the Clear button', () => {
      const wrapper = mount(ModelInfoBar, { props: { model: aliasModel } });
      expect(wrapper.text()).toContain('Clear');
    });
  });
});
