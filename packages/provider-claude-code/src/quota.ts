// `anthropic-ratelimit-unified-*` header parser. Anthropic returns this
// family on every /v1/messages response; the field set evolves with the CLI
// version, so the parser is permissive: known fields are typed, anything
// else flows through `raw` for dashboard display.
//
// Header set captured from a live Anthropic OAuth response on 2026-06-19
// (Sonnet 4.5 on a plan-tier account):
//
//   anthropic-ratelimit-unified-status: allowed
//   anthropic-ratelimit-unified-5h-status: allowed
//   anthropic-ratelimit-unified-5h-reset: 1781805000
//   anthropic-ratelimit-unified-5h-utilization: 0.0
//   anthropic-ratelimit-unified-7d-status: allowed
//   anthropic-ratelimit-unified-7d-reset: 1782039600
//   anthropic-ratelimit-unified-7d-utilization: 0.0
//   anthropic-ratelimit-unified-representative-claim: five_hour
//   anthropic-ratelimit-unified-fallback-percentage: 0.5
//   anthropic-ratelimit-unified-reset: 1781805000
//   anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits
//   anthropic-ratelimit-unified-overage-status: rejected
//
// Reset values arrive as unix-seconds timestamps; we convert to ISO 8601
// so the dashboard renders them without extra knowledge.

const HEADER_PREFIX = 'anthropic-ratelimit-';

export interface ClaudeCodeQuotaWindow {
  status: string | null;
  reset: string | null;
  utilization: number | null;
}

export interface ClaudeCodeQuotaSevenDay {
  status: string | null;
  reset: string | null;
  utilization: number | null;
  surpassedThreshold: boolean | null;
}

export interface ClaudeCodeQuotaOverage {
  status: string | null;
  reset: string | null;
  utilization: number | null;
  disabledReason: string | null;
}

export interface ClaudeCodeQuotaSnapshot {
  status: string | null;
  reset: string | null;
  fallback: boolean | null;
  fallbackPercentage: number | null;
  representativeClaim: string | null;
  overage: ClaudeCodeQuotaOverage | null;
  fiveHour: ClaudeCodeQuotaWindow | null;
  sevenDay: ClaudeCodeQuotaSevenDay | null;
  raw: Record<string, string>;
}

const parseUnixSecondsToIso = (raw: string | null): string | null => {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
};

const parseNumber = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const parseBoolean = (raw: string | null): boolean | null => {
  if (raw === null) return null;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return null;
};

const collectRaw = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith(HEADER_PREFIX)) {
      out[name.toLowerCase()] = value;
    }
  });
  return out;
};

const buildFiveHourWindow = (headers: Headers): ClaudeCodeQuotaWindow | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-5h-status`);
  const reset = headers.get(`${HEADER_PREFIX}unified-5h-reset`);
  const util = headers.get(`${HEADER_PREFIX}unified-5h-utilization`);
  if (status === null && reset === null && util === null) return null;
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
  };
};

const buildSevenDayWindow = (headers: Headers): ClaudeCodeQuotaSevenDay | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-7d-status`);
  const reset = headers.get(`${HEADER_PREFIX}unified-7d-reset`);
  const util = headers.get(`${HEADER_PREFIX}unified-7d-utilization`);
  const surpassed = headers.get(`${HEADER_PREFIX}unified-7d-surpassed-threshold`);
  if (status === null && reset === null && util === null && surpassed === null) return null;
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
    surpassedThreshold: parseBoolean(surpassed),
  };
};

const buildOverage = (headers: Headers): ClaudeCodeQuotaOverage | null => {
  const status = headers.get(`${HEADER_PREFIX}unified-overage-status`);
  const reset = headers.get(`${HEADER_PREFIX}unified-overage-reset`);
  const util = headers.get(`${HEADER_PREFIX}unified-overage-utilization`);
  const disabledReason = headers.get(`${HEADER_PREFIX}unified-overage-disabled-reason`);
  if (status === null && reset === null && util === null && disabledReason === null) return null;
  return {
    status,
    reset: parseUnixSecondsToIso(reset),
    utilization: parseNumber(util),
    disabledReason,
  };
};

export const parseClaudeCodeQuotaHeaders = (headers: Headers): ClaudeCodeQuotaSnapshot => ({
  status: headers.get(`${HEADER_PREFIX}unified-status`),
  reset: parseUnixSecondsToIso(headers.get(`${HEADER_PREFIX}unified-reset`)),
  fallback: parseBoolean(headers.get(`${HEADER_PREFIX}unified-fallback`)),
  fallbackPercentage: parseNumber(headers.get(`${HEADER_PREFIX}unified-fallback-percentage`)),
  representativeClaim: headers.get(`${HEADER_PREFIX}unified-representative-claim`),
  overage: buildOverage(headers),
  fiveHour: buildFiveHourWindow(headers),
  sevenDay: buildSevenDayWindow(headers),
  raw: collectRaw(headers),
});
