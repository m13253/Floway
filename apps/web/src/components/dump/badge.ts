// One severity classifier shared between the row tint and the status badge
// so a 4xx never reads as two different signals at once. The bucketing tracks
// what an operator can act on: 'err' for hard failures, 'warn' for client
// problems the operator may have caused, 'ok' for normal success.
export type RowSeverity = 'ok' | 'warn' | 'err';

export const rowSeverity = (status: number, error: string | null): RowSeverity => {
  if (status === 0 || error !== null) return 'err';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  return 'ok';
};

// Status badge color class shared between RequestList (the listbox row) and
// RecordDetail (the response header chip). Pulled out because keeping the
// rule one-sourced means an HTTP-color policy change lands in one file.
export const statusBadgeClass = (status: number, error: string | null): string => {
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  case 'warn': return 'bg-accent-amber/15 text-accent-amber border-accent-amber/30';
  case 'ok': return status >= 200 && status < 300
    ? 'bg-accent-emerald/15 text-accent-emerald border-accent-emerald/30'
    : 'bg-surface-700 text-gray-400 border-white/10';
  }
};

// Row tint class for the request list. Severity is the same axis as the
// badge, so amber 4xx rows match their amber badge and rose 5xx/error rows
// match their rose badge — no operator-confusing crossover.
export const rowTintClass = (status: number, error: string | null, selected: boolean): string => {
  if (selected) return 'bg-accent-cyan/10';
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/[0.04] hover:bg-accent-rose/[0.08]';
  case 'warn': return 'bg-accent-amber/[0.04] hover:bg-accent-amber/[0.08]';
  case 'ok': return 'hover:bg-white/[0.02]';
  }
};
