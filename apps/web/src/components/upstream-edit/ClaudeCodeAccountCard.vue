<script setup lang="ts">
// The structured quota slices come straight from
// state.accounts[].quotaSnapshot.data, mirroring what the gateway parsed from
// the most recent /v1/messages response headers.

import { computed } from 'vue';

import type { ClaudeCodeAccountCredentialSummary, ClaudeCodeAccountIdentity, UpstreamRecord } from '../../api/types.ts';
import { Badge, Card } from '@floway-dev/ui';

type ClaudeCodeUpstreamRecord = Extract<UpstreamRecord, { provider: 'claude-code' }>;

const props = defineProps<{
  record: ClaudeCodeUpstreamRecord;
}>();

const HEAVY_USAGE_THRESHOLD_PCT = 80;

const account = computed<ClaudeCodeAccountIdentity | null>(() => {
  return props.record.config.accounts[0] ?? null;
});

type CredentialLookup =
  | { kind: 'present'; credential: ClaudeCodeAccountCredentialSummary }
  | { kind: 'missing-state' }
  | { kind: 'no-config-account' }
  | { kind: 'uuid-mismatch'; expectedAccountUuid: string };

const credentialLookup = computed<CredentialLookup>(() => {
  const raw = props.record.state;
  if (!raw || !Array.isArray(raw.accounts) || raw.accounts.length === 0) return { kind: 'missing-state' };
  const configured = account.value;
  if (!configured) return { kind: 'no-config-account' };
  const match = raw.accounts.find(a => a.accountUuid === configured.accountUuid);
  if (match) return { kind: 'present', credential: match };
  return { kind: 'uuid-mismatch', expectedAccountUuid: configured.accountUuid };
});

const credential = computed<ClaudeCodeAccountCredentialSummary | null>(() => credentialLookup.value.kind === 'present' ? credentialLookup.value.credential : null);

const quota = computed(() => credential.value?.quotaSnapshot?.data ?? null);

const formatTimestamp = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
};

const clampPercent = (n: number | null | undefined): number => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const formatPercent = (n: number | null | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${clampPercent(n)}%`;
};

const formatRelative = (epochMs: number | null | undefined): string => {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  const delta = epochMs - Date.now();
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let body: string;
  if (abs < 60_000) body = 'just now';
  else if (minutes < 60) body = `${minutes} min`;
  else if (hours < 48) body = `${hours} h`;
  else body = `${days} d`;
  return delta >= 0 ? `in ${body}` : `${body} ago`;
};

const badge = computed<{ tone: 'rose' | 'amber' | 'emerald'; label: string; detail?: string }>(() => {
  if (credentialLookup.value.kind === 'uuid-mismatch') {
    return { tone: 'rose', label: 'Configured account missing from state — re-import to recover' };
  }
  if (credentialLookup.value.kind === 'no-config-account') {
    return { tone: 'rose', label: 'Account identity missing from config — re-import to recover' };
  }
  const c = credential.value;
  if (c?.state === 'session_terminated') {
    return { tone: 'rose', label: 'Session terminated — re-import to recover', detail: c.stateMessage };
  }
  if (c?.state === 'refresh_failed') {
    return { tone: 'rose', label: 'Refresh failed — re-import to recover', detail: c.stateMessage };
  }
  const overageStatus = quota.value?.overage?.status;
  if (overageStatus === 'rejected') {
    return { tone: 'rose', label: 'Overage rejected — limit reached' };
  }
  const utilizations = [quota.value?.fiveHour?.utilization, quota.value?.sevenDay?.utilization]
    .filter((v): v is number => typeof v === 'number');
  const heaviest = utilizations.length ? Math.max(...utilizations) * 100 : null;
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PCT) {
    return { tone: 'amber', label: `Heavy usage (${Math.round(heaviest)}%)` };
  }
  return { tone: 'emerald', label: 'Active' };
});

const accountIdShort = computed(() => {
  const id = account.value?.accountUuid;
  if (!id) return '';
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
});

const windows = computed(() => {
  const q = quota.value;
  if (!q) return [];
  const toPercent = (n: number | null | undefined): number | null => typeof n === 'number' ? n * 100 : null;
  return [
    { label: '5-hour window', percent: toPercent(q.fiveHour?.utilization), resetAt: q.fiveHour?.reset, status: q.fiveHour?.status },
    { label: '7-day window', percent: toPercent(q.sevenDay?.utilization), resetAt: q.sevenDay?.reset, status: q.sevenDay?.status },
  ];
});

const accessTokenExpiry = computed(() => {
  const t = credential.value?.accessToken;
  if (!t) return null;
  return { expiresAt: t.expiresAt, relative: formatRelative(t.expiresAt) };
});

const rawEntries = computed<Array<[string, string]>>(() => {
  const raw = quota.value?.raw;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
});
</script>

<template>
  <Card :padded="false" class="space-y-4 p-4">
    <div class="flex items-start gap-3">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-gray-400">
        <i class="i-lucide-bot size-6" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <p class="truncate text-sm font-medium text-white">{{ account?.email }}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <Badge v-if="account?.subscriptionType" tone="rose" size="sm" class="!uppercase tracking-wide">{{ account.subscriptionType }}</Badge>
          <span v-if="account" class="font-mono text-[11px] text-gray-500" :title="account.accountUuid">{{ accountIdShort }}</span>
        </div>
      </div>
      <Badge :tone="badge.tone" size="sm">{{ badge.label }}</Badge>
    </div>

    <p v-if="badge.detail" class="text-xs text-gray-500">{{ badge.detail }}</p>

    <p
      v-if="credentialLookup.kind === 'uuid-mismatch'"
      class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose"
    >
      Configured account
      <code class="font-mono">{{ credentialLookup.expectedAccountUuid }}</code>
      is not present in the gateway's stored state. Re-import the credential to re-link the account.
    </p>

    <p
      v-if="credentialLookup.kind === 'no-config-account'"
      class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose"
    >
      The upstream's stored state has account credentials but the config has no
      identity record. Re-import the credential to populate the identity.
    </p>

    <template v-if="quota">
      <div class="space-y-3">
        <div v-for="w in windows" :key="w.label" class="space-y-1">
          <div class="flex items-baseline justify-between text-xs">
            <span class="text-gray-300">{{ w.label }}</span>
            <span class="text-gray-500">{{ formatPercent(w.percent) }}<template v-if="w.status"> · {{ w.status }}</template></span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-rose transition-[width]"
              :style="{ width: `${clampPercent(w.percent)}%` }"
            />
          </div>
          <p v-if="w.resetAt" class="text-[11px] text-gray-500">Resets at {{ formatTimestamp(w.resetAt) }}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge v-if="quota.representativeClaim" tone="zinc" size="sm">representative: {{ quota.representativeClaim }}</Badge>
        <Badge v-if="quota.overage?.status" tone="zinc" size="sm">overage: {{ quota.overage.status }}</Badge>
        <Badge v-if="quota.overage?.disabledReason" tone="rose" size="sm">disabled: {{ quota.overage.disabledReason }}</Badge>
        <Badge v-if="quota.fallbackAvailable === false" tone="amber" size="sm">fallback unavailable</Badge>
      </div>

      <details v-if="rawEntries.length" class="text-[11px] text-gray-500">
        <summary class="cursor-pointer select-none text-gray-400 hover:text-gray-200">Raw quota headers ({{ rawEntries.length }})</summary>
        <dl class="mt-2 space-y-1 font-mono">
          <div v-for="[k, v] in rawEntries" :key="k" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <dt class="truncate text-gray-500" :title="k">{{ k }}</dt>
            <dd class="truncate text-gray-300" :title="v">{{ v }}</dd>
          </div>
        </dl>
      </details>

      <footer class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
        <span v-if="credential?.stateUpdatedAt">state updated {{ formatTimestamp(credential.stateUpdatedAt) }}</span>
        <span v-if="accessTokenExpiry">access token expires {{ accessTokenExpiry.relative }}</span>
      </footer>
    </template>

    <template v-else>
      <p class="text-xs text-gray-500">No quota snapshot yet. Make a Claude Code call to populate.</p>
      <footer v-if="accessTokenExpiry || credential?.stateUpdatedAt" class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
        <span v-if="credential?.stateUpdatedAt">state updated {{ formatTimestamp(credential.stateUpdatedAt) }}</span>
        <span v-if="accessTokenExpiry">access token expires {{ accessTokenExpiry.relative }}</span>
      </footer>
    </template>
  </Card>
</template>
