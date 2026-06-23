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

// At-a-glance gateway-answered-OK signal: check on 2xx, cross (severity-
// tinted) otherwise. The exact status code and any error string surface
// elsewhere (list-row trailer, detail-section error caption).
export interface StatusIcon {
  readonly iconClass: string;
  readonly colorClass: string;
  readonly tooltip: string;
}

export const statusIcon = (status: number | null, error: string | null): StatusIcon => {
  const tooltip = status === null ? 'No response' : `HTTP ${status}`;
  switch (rowSeverity(status, error)) {
  case 'ok': return { iconClass: 'i-lucide-check', colorClass: 'text-accent-emerald', tooltip };
  case 'warn': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-amber', tooltip };
  case 'err': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-rose', tooltip };
  }
};
