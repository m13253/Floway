// GET /api/performance — query backend-aggregated latency telemetry.
//
// View semantics mirror /api/token-usage and /api/search-usage:
// - `self-by-key` scopes rows to the actor's keys (active + soft-deleted) and
//   keeps the existing per-key groupBy options. `group_by=userId` is rejected
//   in this mode — every row already belongs to the actor.
// - `all-by-user` aggregates across every row (callers must have
//   `canViewGlobalTelemetry`). `group_by=keyId` is rejected so we never leak
//   another user's key id into a global response; `group_by=userId` is the
//   symmetric grouping operators reach for. The /overview series defaults to
//   the userId grouping so the dashboard renders one line per user — model
//   and runtime tables stay grouped by their respective dimensions.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceMetricScope, PerformanceTelemetryRecord } from '../../repo/types.ts';
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
// 'start and end query parameters are required' message rather than a generic
// zod-shaped error so the dashboard's inline-error rendering stays intact.
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
  if (resolved.view === 'self-by-key' && params.groupBy === 'userId') {
    return { error: 'bad_request', message: 'group_by=userId is not allowed in self-by-key mode' };
  }
  return resolved;
};

const queryRecordsForView = async (
  resolved: ResolvedTelemetryView,
  params: PerformanceQueryParams,
): Promise<readonly PerformanceTelemetryRecord[] | null> => {
  const repo = getRepo();
  if (resolved.view === 'all-by-user') {
    return await repo.performance.query({
      start: params.start,
      end: params.end,
      metricScope: params.metricScope,
    });
  }

  const ownedIds = await repo.apiKeys.idsByUserIdIncludingDeleted(resolved.scopeUserId);
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

// keyId → userId map. Includes soft-deleted keys so historical telemetry on a
// since-deleted key still resolves.
const buildKeyToUserMap = async (): Promise<ReadonlyMap<string, number>> => {
  const keys = await getRepo().apiKeys.listIncludingDeleted();
  return new Map(keys.map(k => [k.id, k.userId] as const));
};

export const performanceTelemetry = async (c: Ctx) => {
  const params = readPerformanceQuery(c, { bucket: 'hour', groupBy: 'model' });
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  const rawRecords = await queryRecordsForView(resolved, params.value);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  const records = aggregatePerformanceForDisplay(
    rawRecords,
    params.value.groupBy === 'userId'
      ? { ...params.value, groupBy: 'userId', keyToUser: await buildKeyToUserMap() }
      : { ...params.value, groupBy: params.value.groupBy },
  );

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
  const keys = await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
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
  // The series chart on the dashboard pivots its grouping with the view: under
  // all-by-user, the by-model line chart is replaced by a per-user one so the
  // operator sees latency split by who is generating it. The model and runtime
  // tables remain grouped by their respective dimensions in both views.
  const series = resolved.view === 'all-by-user'
    ? aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: params.value.bucket, groupBy: 'userId', keyToUser: await buildKeyToUserMap() })
    : aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: params.value.bucket, groupBy: 'model' });
  const summaryRows = aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'none' });
  const modelRows = aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'model' });
  const runtimeRows = aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'runtimeLocation' });

  const query = c.req.valid('query');

  if (resolved.view === 'all-by-user') {
    if (query.include_user_metadata !== '1') return c.json({ series, summaryRows, modelRows, runtimeRows });
    const users = await getRepo().users.listIncludingDeleted();
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username, deletedAt: u.deletedAt }))
      .sort((a, b) => a.id - b.id);
    return c.json({ series, summaryRows, modelRows, runtimeRows, users: userMetadata, keyColorOrder: USAGE_KEY_COLOR_ORDER });
  }

  return c.json({ series, summaryRows, modelRows, runtimeRows });
};
