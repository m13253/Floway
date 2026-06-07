// Compact countdown formatter for the proxy backoff badges. Takes an
// already-computed millisecond delta so callers stay in control of which
// `now` they sample against (most pair this with a `useNow` ref so the
// label re-renders on the dashboard's 1s tick).
//
// Returns "now" for non-positive deltas, then walks "<s>s" → "<m>m <s>s" →
// "<h>h <m>m" granularities.

export const formatCountdown = (ms: number): string => {
  if (ms <= 0) return 'now';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};
