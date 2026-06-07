// GET /api/performance — query backend-aggregated latency telemetry.
//
// View semantics mirror /api/token-usage and /api/search-usage:
// - `self-by-key` scopes rows to the actor's keys (active + soft-deleted) and
//   keeps the existing per-key groupBy options.
// - `all-by-user` aggregates across every row (callers must have
//   `canViewGlobalTelemetry`). The handler does not introduce a `userId`
//   groupBy in this iteration; instead the dashboard groups by model /
//   sourceApi / runtimeLocation / etc., which all stay meaningful cross-user.
//   `group_by=keyId` is rejected in all-by-user mode so we never leak another
//   user's key id into a global response.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceMetricScope } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { resolveTelemetryView, type ResolvedTelemetryView } from '../telemetry-view.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceQueryParams {
  keyId: string | undefined;
  start: string;
  end: string;
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  metricScope: PerformanceMetricScope;
  timezoneOffsetMinutes: number;
}

// Schema-validated query → handler-facing params. Returns the canonical
// "start and end query parameters are required" message rather than a generic
// zod-shaped error to preserve the existing dashboard inline-error UX.
const readPerformanceQuery = (
  c: Ctx,
  defaults: { bucket: PerformanceBucketGranularity; groupBy: PerformanceGroupBy },
): { type: 'ok'; value: PerformanceQueryParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  const start = query.start ?? '';
  const end = query.end ?? '';
  if (!start || !end) {
    return { type: 'error', error: 'start and end query parameters are required (e.g. 2026-03-09T00)' };
  }

  const timezoneOffsetMinutes = Number(query.timezone_offset_minutes ?? '0');
  if (!Number.isFinite(timezoneOffsetMinutes) || timezoneOffsetMinutes < -1440 || timezoneOffsetMinutes > 1440) {
    return { type: 'error', error: 'timezone_offset_minutes must be between -1440 and 1440' };
  }

  return {
    type: 'ok',
    value: {
      keyId: query.key_id === '' ? undefined : query.key_id,
      start,
      end,
      bucket: query.bucket ?? defaults.bucket,
      groupBy: query.group_by ?? defaults.groupBy,
      metricScope: query.metric_scope ?? 'request_total',
      timezoneOffsetMinutes,
    },
  };
};

const resolveView = (
  c: Ctx,
  params: PerformanceQueryParams,
): ResolvedTelemetryView | { error: 'forbidden' | 'bad_request'; message: string } => {
  const resolved = resolveTelemetryView(c, c.req.valid('query').view, params.keyId);
  if ('error' in resolved) return resolved;
  if (resolved.view === 'all-by-user' && params.groupBy === 'keyId') {
    return { error: 'bad_request', message: 'group_by=keyId is not allowed in all-by-user mode' };
  }
  return resolved;
};

const queryRecordsForView = async (
  resolved: ResolvedTelemetryView,
  params: PerformanceQueryParams,
) => {
  const repo = getRepo();
  if (resolved.view === 'all-by-user') {
    return await repo.performance.query({
      start: params.start,
      end: params.end,
      metricScope: params.metricScope,
    });
  }

  const ownedIds = await repo.apiKeys.idsByUserId(resolved.scopeUserId!, { includeDeleted: true });
  const ownedSet = new Set(ownedIds);
  if (params.keyId !== undefined && !ownedSet.has(params.keyId)) {
    return null;
  }
  const rows = await repo.performance.query({
    keyId: params.keyId,
    start: params.start,
    end: params.end,
    metricScope: params.metricScope,
  });
  return params.keyId ? rows : rows.filter(r => ownedSet.has(r.keyId));
};

export const performanceTelemetry = async (c: Ctx) => {
  const params = readPerformanceQuery(c, { bucket: 'hour', groupBy: 'model' });
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  const rawRecords = await queryRecordsForView(resolved, params.value);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  const records = aggregatePerformanceForDisplay(rawRecords, {
    bucket: params.value.bucket,
    groupBy: params.value.groupBy,
    timezoneOffsetMinutes: params.value.timezoneOffsetMinutes,
  });

  const query = c.req.valid('query');
  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    if (query.include_user_metadata !== '1') return c.json({ records });
    const users = await repo.users.listIncludingDeleted();
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username, deletedAt: u.deletedAt }))
      .sort((a, b) => a.id - b.id);
    return c.json({ records, users: userMetadata, keyColorOrder: USAGE_KEY_COLOR_ORDER });
  }

  if (query.include_key_metadata !== '1') return c.json({ records });
  const keys = await repo.apiKeys.listByUserId(resolved.scopeUserId!);
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({ records, keys: keyMetadata, keyColorOrder: USAGE_KEY_COLOR_ORDER });
};

export const performanceOverview = async (c: Ctx) => {
  const params = readPerformanceQuery(c, { bucket: 'hour', groupBy: 'model' });
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  const rawRecords = await queryRecordsForView(resolved, params.value);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  const baseOptions = { timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };

  return c.json({
    series: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: params.value.bucket, groupBy: 'model' }),
    summaryRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'none' }),
    modelRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'model' }),
    runtimeRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'runtimeLocation' }),
  });
};
