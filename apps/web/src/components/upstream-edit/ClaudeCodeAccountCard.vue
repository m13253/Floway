<script setup lang="ts">
// Identity + state + quota summary for one Claude Code account. Pure
// presentation — no API calls. The structured quota slices come straight
// from state.accounts[].quotaSnapshot.data, mirroring what the gateway
// parsed from the most recent /v1/messages response headers.

import { computed, ref } from 'vue';

import type { ClaudeCodeAccountCredentialSummary, ClaudeCodeAccountIdentity, ClaudeCodeUpstreamConfig, ClaudeCodeUpstreamState, UpstreamRecord } from '../../api/types.ts';
import { Badge, Card } from '@floway-dev/ui';

const props = defineProps<{
  record: UpstreamRecord;
}>();

const account = computed<ClaudeCodeAccountIdentity | null>(() => {
  const cfg = props.record.config as ClaudeCodeUpstreamConfig;
  return cfg.accounts[0] ?? null;
});

const credential = computed<ClaudeCodeAccountCredentialSummary | null>(() => {
  const raw = props.record.state as ClaudeCodeUpstreamState | null;
  if (!raw || !Array.isArray(raw.accounts)) return null;
  if (!account.value) return raw.accounts[0] ?? null;
  return raw.accounts.find(a => a.accountUuid === account.value!.accountUuid) ?? raw.accounts[0] ?? null;
});

const quota = computed(() => credential.value?.quotaSnapshot?.data ?? null);

const formatTimestamp = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

const formatPercent = (n: number | null | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
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
  if (heaviest !== null && heaviest >= 80) {
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
  // Display utilizations as percent (Anthropic returns 0..1 fractions).
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

const rawOpen = ref(false);
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
          <Badge v-if="account" tone="rose" size="sm" class="!uppercase tracking-wide">{{ account.subscriptionType }}</Badge>
          <span v-if="account" class="font-mono text-[11px] text-gray-500" :title="account.accountUuid">{{ accountIdShort }}</span>
        </div>
      </div>
      <Badge :tone="badge.tone" size="sm">{{ badge.label }}</Badge>
    </div>

    <p v-if="badge.detail" class="text-xs text-gray-500">{{ badge.detail }}</p>

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
              :style="{ width: `${Math.max(0, Math.min(100, Math.round(w.percent ?? 0)))}%` }"
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

      <details v-if="rawEntries.length" class="text-[11px] text-gray-500" :open="rawOpen" @toggle="(e: Event) => rawOpen = (e.target as HTMLDetailsElement).open">
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
