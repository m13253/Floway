<script setup lang="ts">
import { useNow } from '@vueuse/core';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Spinner } from '@floway-dev/ui';
import { computed } from 'vue';

import type { BackoffRow, ProxyRecord } from '../../api/types.ts';

dayjs.extend(relativeTime);

const props = defineProps<{
  proxy: ProxyRecord;
  backoffsForProxy: BackoffRow[];
  upstreamNames: Map<string, string>;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
  testInFlight: boolean;
  testError: string | null;
}>();

defineEmits<{
  test: [];
  resetBackoffs: [];
  edit: [];
  delete: [];
  moveUp: [];
  moveDown: [];
}>();

// Live tick so backoff countdowns visibly decrement without a parent reload.
// 1s granularity matches the "in Xm Ys" precision we render.
const now = useNow({ interval: 1000 });

// Best-effort proxy-kind label derived from the URL scheme. The editor uses
// the real `parseProxyUri` for live validation, but the settings card just
// needs a stable colour-code per row — the scheme alone is enough, and the
// regex-free dispatch keeps the list cheap to render even with many rows.
const kindOf = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'PROXY';
  }
  switch (parsed.protocol) {
  case 'http:': return 'HTTP';
  case 'https:': return 'HTTPS';
  case 'socks5:':
  case 'socks5h:': return 'SOCKS5';
  case 'ss:': {
    // ss2022 ciphers begin with `2022-blake3-`; the userinfo carries either
    // `method:password` (legacy SS) or the same with a 2022 cipher prefix.
    const userinfo = decodeURIComponent(parsed.username || '');
    return userinfo.startsWith('2022-blake3-') ? 'SS-2022' : 'SS';
  }
  case 'trojan:': return 'TROJAN';
  case 'vless:': {
    // REALITY uses `security=reality`; vless-over-WS uses `type=ws`. Anything
    // else falls back to the bare protocol label.
    const security = parsed.searchParams.get('security');
    const transport = parsed.searchParams.get('type');
    if (security === 'reality') return 'REALITY';
    if (transport === 'ws') return 'VLESS-WS';
    return 'VLESS';
  }
  default: return parsed.protocol.replace(/:$/, '').toUpperCase() || 'PROXY';
  }
};

const kindBadgeClass = (kind: string) => {
  switch (kind) {
  case 'HTTP':
  case 'HTTPS': return 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan';
  case 'SOCKS5': return 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald';
  case 'SS':
  case 'SS-2022': return 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet';
  case 'TROJAN': return 'border-accent-rose/30 bg-accent-rose/10 text-accent-rose';
  case 'REALITY':
  case 'VLESS':
  case 'VLESS-WS': return 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber';
  default: return 'border-white/10 bg-white/5 text-gray-400';
  }
};

const kind = computed(() => kindOf(props.proxy.url));

// Strip userinfo before display: shadowsocks and trojan URIs embed the secret
// as the userinfo segment, and we do not want it leaking into a tooltip.
const urlPreview = computed(() => {
  let parsed: URL;
  try {
    parsed = new URL(props.proxy.url);
  } catch {
    return props.proxy.url;
  }
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${host}${port}${parsed.pathname === '/' ? '' : parsed.pathname}`;
});

const lastTestedAgo = computed(() => {
  if (props.proxy.last_tested_at == null) return null;
  return dayjs(props.proxy.last_tested_at).from(dayjs(now.value));
});

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return 'now';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};

const activeBackoffs = computed(() => {
  const nowMs = now.value.getTime();
  return props.backoffsForProxy
    .filter(b => b.expires_at > nowMs)
    .sort((a, b) => a.expires_at - b.expires_at);
});

const visibleBackoffs = computed(() => activeBackoffs.value.slice(0, 3));
const extraBackoffCount = computed(() => Math.max(0, activeBackoffs.value.length - 3));
const hasBackoffs = computed(() => activeBackoffs.value.length > 0);
const hasEgressInfo = computed(() => props.proxy.last_egress_ip !== null || props.proxy.last_tested_at !== null);
const showExpansion = computed(() => hasEgressInfo.value || hasBackoffs.value);

const upstreamLabel = (id: string) => props.upstreamNames.get(id) ?? id;
</script>

<template>
  <div class="rounded-lg border border-white/5 bg-surface-800/80 p-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 flex-1">
        <div class="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <span
            class="rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
            :class="kindBadgeClass(kind)"
          >{{ kind }}</span>
        </div>
        <p class="truncate text-sm font-semibold text-white">{{ proxy.name }}</p>
        <p class="truncate text-xs text-gray-500" :title="urlPreview">{{ urlPreview }}</p>
        <p v-if="testError" class="mt-1 text-xs text-accent-rose">{{ testError }}</p>
      </div>

      <div class="flex shrink-0 items-center justify-end gap-1.5">
        <button
          type="button"
          class="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-40"
          :disabled="testInFlight"
          aria-label="Test proxy"
          title="Test proxy egress"
          @click="$emit('test')"
        >
          <Spinner v-if="testInFlight" class="h-3.5 w-3.5" />
          <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
          Test
        </button>

        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
          :disabled="moveUpDisabled"
          aria-label="Move proxy up"
          title="Move up"
          @click="$emit('moveUp')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
          :disabled="moveDownDisabled"
          aria-label="Move proxy down"
          title="Move down"
          @click="$emit('moveDown')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
          aria-label="Edit proxy"
          title="Edit"
          @click="$emit('edit')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          aria-label="Delete proxy"
          title="Delete"
          @click="$emit('delete')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="showExpansion" class="mt-2 border-t border-white/[0.04] pt-2 text-xs text-gray-500">
      <div v-if="hasEgressInfo" class="flex flex-wrap items-center gap-x-2">
        <span class="text-gray-600">Egress:</span>
        <span v-if="proxy.last_egress_ip" class="font-mono text-gray-400">{{ proxy.last_egress_ip }}</span>
        <span v-else class="italic">untested</span>
        <span v-if="lastTestedAgo" class="text-gray-600">({{ lastTestedAgo }})</span>
      </div>
      <div v-if="hasBackoffs" class="mt-1 flex flex-wrap items-center gap-x-2">
        <span class="text-gray-600">Backoff:</span>
        <span
          v-for="row in visibleBackoffs"
          :key="row.upstream_id"
          class="text-accent-amber"
          :title="row.last_error ?? undefined"
        >
          {{ upstreamLabel(row.upstream_id) }}
          <span class="text-gray-600">(in {{ formatCountdown(row.expires_at - now.getTime()) }})</span>
        </span>
        <span v-if="extraBackoffCount > 0" class="text-gray-600">+{{ extraBackoffCount }} more</span>
        <button
          type="button"
          class="ml-auto rounded px-1.5 py-0.5 text-xs text-gray-400 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          @click="$emit('resetBackoffs')"
        >Reset all</button>
      </div>
    </div>
  </div>
</template>
