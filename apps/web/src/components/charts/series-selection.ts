import type { ChartConfiguration } from 'chart.js/auto';

export interface SeriesTaggedDataset {
  seriesId?: string;
}

export type SeriesSelectionAction = 'all' | 'invert' | 'none';

export const chartSeriesIds = (config: ChartConfiguration<'line'>): string[] => config.data.datasets
  .map(dataset => (dataset as SeriesTaggedDataset).seriesId)
  .filter((id): id is string => typeof id === 'string');

export const datasetSeriesIds = (datasets: readonly unknown[]): string[] => datasets
  .map(dataset => (dataset as SeriesTaggedDataset).seriesId)
  .filter((id): id is string => typeof id === 'string');

export const chartEventsWithDoubleClick: (keyof HTMLElementEventMap)[] = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'dblclick'];

export const applySeriesSelection = (hidden: Set<string>, ids: readonly string[], action: SeriesSelectionAction) => {
  if (action === 'all') {
    hidden.clear();
    return;
  }
  const nextHidden = action === 'none' ? ids : ids.filter(id => !hidden.has(id));
  hidden.clear();
  for (const id of nextHidden) hidden.add(id);
};

const activeSeriesIds = (hidden: Set<string>, ids: readonly string[]): string[] => ids.filter(id => !hidden.has(id));

export class SeriesIsolationController {
  private exitCandidate: string | null = null;

  toggle(hidden: Set<string>, id: string) {
    if (this.exitCandidate !== id) this.exitCandidate = null;
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
  }

  isolateOrSelectAll(hidden: Set<string>, ids: readonly string[], id: string) {
    const active = activeSeriesIds(hidden, ids);
    if ((active.length === 1 && active[0] === id) || this.exitCandidate === id) {
      hidden.clear();
      this.exitCandidate = null;
      return;
    }
    hidden.clear();
    for (const seriesId of ids) if (seriesId !== id) hidden.add(seriesId);
    this.exitCandidate = id;
  }
}

export const handleLegendClick = (
  event: { native?: Event | null },
  controller: SeriesIsolationController,
  hidden: Set<string>,
  ids: readonly string[],
  id: string,
) => {
  const native = event.native;
  if (native instanceof MouseEvent && native.shiftKey) controller.isolateOrSelectAll(hidden, ids, id);
  else if (native instanceof MouseEvent && (native.detail & 1) === 0) controller.isolateOrSelectAll(hidden, ids, id);
  else controller.toggle(hidden, id);
};
