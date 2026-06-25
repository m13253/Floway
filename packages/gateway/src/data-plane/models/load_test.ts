import { describe, expect, test } from 'vitest';

import { toPublicModel } from './load.ts';
import type { InternalModel } from '@floway-dev/provider';

const base: InternalModel = {
  id: 'm1',
  kind: 'chat',
  limits: { max_context_window_tokens: 100000 },
};

describe('toPublicModel', () => {
  test('omits chat when not set', () => {
    expect(toPublicModel(base).chat).toBeUndefined();
  });

  test('propagates chat metadata verbatim', () => {
    const chat = {
      modalities: { input: ['text', 'image'] as const, output: ['text'] as const },
      reasoning: { supported_efforts: ['low', 'high'] as const, default_effort: 'low' },
    };
    expect(toPublicModel({ ...base, chat }).chat).toEqual(chat);
  });
});
