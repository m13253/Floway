type RowSeverity = 'ok' | 'warn' | 'err';

export const rowSeverity = (status: number | null, error: string | null): RowSeverity => {
  if (status === null || error !== null) return 'err';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  return 'ok';
};

export const rowTintClass = (status: number | null, error: string | null, selected: boolean): string => {
  if (selected) return 'bg-accent-cyan/10';
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/[0.04] hover:bg-accent-rose/[0.08]';
  case 'warn': return 'bg-accent-amber/[0.04] hover:bg-accent-amber/[0.08]';
  case 'ok': return 'hover:bg-white/[0.02]';
  }
};

// The status of the dumped response, expressed as a check/cross glyph. The
// actual status code and any error string surface in the row's trailer
// (`record.error`) and in the detail-section error caption, so this is just
// the "did the gateway end up answering OK or not" signal at a glance. A 2xx
// with no error is a check; everything else (4xx / 5xx / null status /
// non-null error) is a cross, tinted by severity.
export interface StatusIcon {
  readonly iconClass: string;
  readonly colorClass: string;
  // Tooltip / aria-label fallback so the glyph stays accessible.
  readonly tooltip: string;
}

const statusTooltip = (status: number | null): string => status === null ? 'No response' : `HTTP ${status}`;

export const statusIcon = (status: number | null, error: string | null): StatusIcon => {
  switch (rowSeverity(status, error)) {
  case 'ok': return { iconClass: 'i-lucide-check', colorClass: 'text-accent-emerald', tooltip: statusTooltip(status) };
  case 'warn': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-amber', tooltip: statusTooltip(status) };
  case 'err': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-rose', tooltip: statusTooltip(status) };
  }
};
