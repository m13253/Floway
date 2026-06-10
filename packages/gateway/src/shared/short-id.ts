// Random short id with a typed prefix. Replaces dashes (so the result
// stays URL- and SQL-safe) and trims to a 24-char tail — wider than a
// random subspace needs, so collisions across our id namespaces stay
// negligible without bloating the wire shape. Used for upstream/proxy
// row ids and for synthesized server-tool item ids that need to be
// distinguishable from upstream-emitted ids.

export const shortId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
