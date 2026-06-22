import { test } from 'vitest';

import { tokenUsageFromChatCompletionsUsage } from './usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Chat usage maps disjoint input/cache/output counts and omits tier when service_tier is absent', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } },
      null,
    ),
    {
      input: 70,
      input_cache_read: 30,
      output: 20,
    },
  );
});

test('Chat usage drops service_tier=default to no-tier', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'default',
    ),
    {
      input: 10,
      output: 2,
    },
  );
});

test('Chat usage forwards service_tier=priority verbatim', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'priority',
    ),
    {
      input: 10,
      output: 2,
      tier: 'priority',
    },
  );
});

test('Chat usage forwards service_tier=flex verbatim', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'flex',
    ),
    {
      input: 10,
      output: 2,
      tier: 'flex',
    },
  );
});

test('Chat usage forwards an unknown tier verbatim (forward-compat with a future wire value)', () => {
  // A future OpenAI value the SDK has not minted yet must reach the billing
  // record so the operator can backfill a per-tier pricing override for it
  // rather than have it silently fold into the base bucket.
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'super-priority',
    ),
    {
      input: 10,
      output: 2,
      tier: 'super-priority',
    },
  );
});
