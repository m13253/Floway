// Per-upstream model name prefix. When set, a routing layer can address the
// upstream's models in two forms — bare id (e.g. "gpt-4o") and prefix-qualified
// (e.g. "openrouter/gpt-4o") — and the listing layer can publish either or
// both. The shape is generic across providers; the registry interprets it.
//
// `addressable` is what the data plane accepts on inbound requests; `listed`
// (always a subset of addressable) is what /v1/models surfaces. Splitting the
// two lets an operator publish a single canonical form while still accepting
// the prefixed form during a migration, or vice versa.

export type AddressableForm = 'unprefixed' | 'prefixed';

export interface ModelPrefixConfig {
  prefix: string;
  addressable: AddressableForm[];
  listed: AddressableForm[];
}

// Matches a prefix string that is itself a non-empty token (no leading slash,
// no empty trailing segment) and ends with exactly one trailing slash. The
// trailing slash is part of the prefix so that simple string concatenation
// produces the addressable id without any join policy.
export const MODEL_PREFIX_REGEX = /^[a-zA-Z0-9._-]([a-zA-Z0-9._/-]*[a-zA-Z0-9._-])?\/$/;

const FORM_ORDER: readonly AddressableForm[] = ['unprefixed', 'prefixed'];

const canonical = (forms: readonly AddressableForm[]): AddressableForm[] => {
  const set = new Set(forms);
  return FORM_ORDER.filter(f => set.has(f));
};

export const normalizeModelPrefix = (input: unknown): ModelPrefixConfig | null => {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') throw new Error('modelPrefix must be an object or null');
  const raw = input as { prefix?: unknown; addressable?: unknown; listed?: unknown };

  if (typeof raw.prefix !== 'string' || !MODEL_PREFIX_REGEX.test(raw.prefix)) {
    throw new Error('modelPrefix.prefix is invalid');
  }
  if (!Array.isArray(raw.addressable) || !Array.isArray(raw.listed)) {
    throw new Error('modelPrefix.addressable and modelPrefix.listed must be arrays');
  }
  const addressable = canonical(raw.addressable as readonly AddressableForm[]);
  const listedCandidate = canonical(raw.listed as readonly AddressableForm[]);
  if (addressable.length === 0) throw new Error('modelPrefix.addressable must be non-empty');
  const addressableSet = new Set(addressable);
  const listed = listedCandidate.filter(f => addressableSet.has(f));
  return { prefix: raw.prefix, addressable, listed };
};
