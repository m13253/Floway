type RowSeverity = 'ok' | 'warn' | 'err';

export const rowSeverity = (status: number | null, error: string | null): RowSeverity => {
  if (status === null || error !== null) return 'err';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  return 'ok';
};

export const statusBadgeClass = (status: number | null, error: string | null): string => {
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  case 'warn': return 'bg-accent-amber/15 text-accent-amber border-accent-amber/30';
  case 'ok': return status !== null && status >= 200 && status < 300
    ? 'bg-accent-emerald/15 text-accent-emerald border-accent-emerald/30'
    : 'bg-surface-700 text-gray-400 border-white/10';
  }
};

export const rowTintClass = (status: number | null, error: string | null, selected: boolean): string => {
  if (selected) return 'bg-accent-cyan/10';
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/[0.04] hover:bg-accent-rose/[0.08]';
  case 'warn': return 'bg-accent-amber/[0.04] hover:bg-accent-amber/[0.08]';
  case 'ok': return 'hover:bg-white/[0.02]';
  }
};
