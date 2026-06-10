// Compact "in Xm Ys" formatter for backoff badges. Pass the precomputed delta (callers control which 'now' they sample, usually a useNow ref). expiredLabel = 'now' for list-row badges (about to disappear) vs 'expiring' for the edit-dialog row (last tick before clear).

export const formatCountdown = (ms: number, expiredLabel: 'now' | 'expiring' = 'now'): string => {
  if (ms <= 0) return expiredLabel;
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};

export const formatRelativeAgo = (deltaMs: number): string => {
  if (deltaMs < 0) return 'just now';
  const totalSec = Math.floor(deltaMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
