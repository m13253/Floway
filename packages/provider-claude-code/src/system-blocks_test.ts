import { describe, expect, test } from 'vitest';

import {
  buildBillingBlock,
  computeCcVersionFingerprint,
  DEFAULT_TEMPLATE_BLOCK,
  IDENTITY_BLOCK,
} from './system-blocks.ts';
import type { MessagesPayload } from '@floway-dev/protocols';

const minimalBody = (firstUserText: string): MessagesPayload => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: firstUserText }],
});

describe('IDENTITY_BLOCK', () => {
  test('is a text block with the byte-exact identity string', () => {
    expect(IDENTITY_BLOCK).toEqual({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  });
});

describe('DEFAULT_TEMPLATE_BLOCK', () => {
  test('is a text block with an ephemeral cache breakpoint', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.type).toBe('text');
    expect(DEFAULT_TEMPLATE_BLOCK.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('opens with the interactive-CLI introduction line', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text.startsWith('You are an interactive CLI tool that helps users')).toBe(true);
  });

  test('contains the canonical tone-and-style and tool-usage sections', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('# Tone and style');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('# Tool usage policy');
    expect(DEFAULT_TEMPLATE_BLOCK.text).toContain('# Doing tasks');
  });

  test('is substantial — at least 5000 chars', () => {
    expect(DEFAULT_TEMPLATE_BLOCK.text.length).toBeGreaterThan(5000);
  });
});

describe('computeCcVersionFingerprint', () => {
  // Vectors computed independently against the spec algorithm:
  //   sha256("59cf53e54c78" + bytes[4,7,20] + version), first 3 hex chars.
  // Padding is 0x30 ('0') for indices past the end of the first user text.
  test('matches the known vector for a long first-user text', () => {
    const body = minimalBody('hello world this is a test prompt');
    // bytes[4]='o' (0x6F), bytes[7]='r' (0x72), bytes[20]='t' (0x74)
    // Actually 'hello world this is a test prompt' — index 4='o', 7='r', 20='a'
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('pads short first-user text with 0x30 and still returns 3 hex chars', () => {
    const body = minimalBody('hi');
    // All three indices fall past end; chars = '000'.
    const fp = computeCcVersionFingerprint('2.1.181', body);
    expect(fp).toBe('2f9');
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
  });

  test('walks past assistant messages to the first user-role text', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'hello world this is a test prompt' },
        { role: 'assistant', content: 'ack' },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('reads the first text block when content is an array', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello world this is a test prompt' }] },
      ],
    };
    expect(computeCcVersionFingerprint('2.1.181', body)).toBe('1f4');
  });

  test('returns 3-hex output for an empty first-user message', () => {
    const body: MessagesPayload = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: '' }],
    };
    const fp = computeCcVersionFingerprint('2.1.181', body);
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
    expect(fp).toBe('2f9'); // same as the all-padding case
  });
});

describe('buildBillingBlock', () => {
  test('produces the byte-exact billing line', () => {
    expect(buildBillingBlock('2.1.181', 'abc')).toEqual({
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=cli; cch=00000;',
    });
  });

  test('always carries the cch=00000 literal placeholder', () => {
    const block = buildBillingBlock('2.1.181', '000');
    expect(block.text).toContain('cch=00000;');
  });
});
