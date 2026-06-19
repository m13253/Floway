// Parse a human-typed retention window. Accepts a plain integer (seconds), or
// an integer followed by `s`/`m`/`h`/`d`. Returns the equivalent number of
// seconds, or null when the input does not parse — callers surface that as a
// validation error rather than substituting a default.
export const parseDuration = (input: string): number | null => {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase() as 's' | 'm' | 'h' | 'd';
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
};
