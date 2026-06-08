export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  totalMsSum: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  summaryRows: PerformanceDisplayRecord[];
  modelRows: PerformanceDisplayRecord[];
  runtimeRows: PerformanceDisplayRecord[];
}
