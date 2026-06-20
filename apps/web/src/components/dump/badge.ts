// Status badge color class shared between RequestList (the listbox row) and
// RecordDetail (the response header chip). Pulled out because keeping the
// rule one-sourced means an HTTP-color policy change lands in one file.
export const statusBadgeClass = (status: number, error: string | null): string => {
  if (status === 0 || error !== null) return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  if (status >= 500) return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  if (status >= 400) return 'bg-accent-amber/15 text-accent-amber border-accent-amber/30';
  if (status >= 200 && status < 300) return 'bg-accent-emerald/15 text-accent-emerald border-accent-emerald/30';
  return 'bg-surface-700 text-gray-400 border-white/10';
};
