import { describe, expect, test } from 'vitest';

import { synthesizeCatalogEntry } from './synthesize.ts';
import type { InternalModel } from '@floway-dev/provider';

const base: InternalModel = {
  id: 'deepseek-v4-pro',
  display_name: 'DeepSeek V4 Pro',
  kind: 'chat',
  limits: { max_context_window_tokens: 128000 },
};

describe('synthesizeCatalogEntry', () => {
  test('returns hardcoded baseline for a text-only chat model', () => {
    const entry = synthesizeCatalogEntry(base);
    expect(entry.slug).toBe('deepseek-v4-pro');
    expect(entry.display_name).toBe('DeepSeek V4 Pro');
    expect(entry.context_window).toBe(128000);
    expect(entry.max_context_window).toBe(128000);
    expect(entry.input_modalities).toEqual(['text']);
    expect(entry.supports_image_detail_original).toBe(false);
    expect(entry.web_search_tool_type).toBe('text');
    expect(entry.shell_type).toBe('shell_command');
    expect(entry.support_verbosity).toBe(false);
    expect(entry.prefer_websockets).toBe(true);
    expect(entry.supports_parallel_tool_calls).toBe(true);
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
    expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 10000 });
    expect(entry.visibility).toBe('list');
    expect(entry.priority).toBe(0);
  });

  test('falls back to id for display_name when absent', () => {
    expect(synthesizeCatalogEntry({ ...base, display_name: undefined }).display_name).toBe('deepseek-v4-pro');
  });

  test('omits context_window when limits missing', () => {
    const entry = synthesizeCatalogEntry({ ...base, limits: {} });
    expect(entry.context_window).toBeUndefined();
    expect(entry.max_context_window).toBeUndefined();
  });

  test('derives image-aware web_search when modalities include image', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
    });
    expect(entry.input_modalities).toEqual(['text', 'image']);
    expect(entry.web_search_tool_type).toBe('text_and_image');
    expect(entry.supports_image_detail_original).toBe(true);
  });

  test('propagates reasoning levels as {effort, description} preset', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { supported_efforts: ['low', 'high'], default_effort: 'low' } },
    });
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort: 'high', description: '' },
    ]);
    expect(entry.default_reasoning_level).toBe('low');
  });
});
