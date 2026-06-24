import { describe, expect, it } from 'vitest';

import { MODEL_PREFIX_REGEX, normalizeModelPrefix } from './model-prefix.ts';

describe('MODEL_PREFIX_REGEX', () => {
  it.each([
    ['a/'],
    ['openrouter/'],
    ['vendor/sub/'],
    ['v1.0/'],
    ['a_b-c/'],
  ])('accepts %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(true));

  it.each([
    ['openrouter'],          // missing trailing slash
    ['/'],                   // too short
    ['/vendor/'],            // leading slash
    ['vendor//'],            // empty trailing segment
    ['my prefix/'],          // space
    ['vendor:/'],            // colon
    [''],                    // empty
  ])('rejects %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(false));
});

describe('normalizeModelPrefix', () => {
  it('returns null for null/undefined', () => {
    expect(normalizeModelPrefix(null)).toBeNull();
    expect(normalizeModelPrefix(undefined)).toBeNull();
  });

  it('normalises listed to subset of addressable', () => {
    const out = normalizeModelPrefix({
      prefix: 'or/',
      addressable: ['unprefixed'],
      listed: ['unprefixed', 'prefixed'],
    });
    expect(out).toEqual({ prefix: 'or/', addressable: ['unprefixed'], listed: ['unprefixed'] });
  });

  it('canonicalises form order to unprefixed-first', () => {
    const out = normalizeModelPrefix({ prefix: 'or/', addressable: ['prefixed', 'unprefixed'], listed: ['prefixed', 'unprefixed'] });
    expect(out!.addressable).toEqual(['unprefixed', 'prefixed']);
    expect(out!.listed).toEqual(['unprefixed', 'prefixed']);
  });

  it('throws when addressable is empty', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or/', addressable: [], listed: [] }))
      .toThrow(/addressable.*non-empty/i);
  });

  it('throws on invalid prefix string', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or', addressable: ['unprefixed'], listed: [] }))
      .toThrow(/prefix.*invalid/i);
  });
});
