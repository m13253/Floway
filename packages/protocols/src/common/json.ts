export type JsonObject = Record<string, unknown>;

// Strict object guard: rejects arrays. Use when keying into an object as if
// it were a JSON dictionary. Shared with the gateway's wider `json-helpers`
// surface; kept here so the moved reassemblers don't reach back across
// package boundaries.
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
