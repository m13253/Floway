<script setup lang="ts">
import { useNow } from '@vueuse/core';
import { computed } from 'vue';

import type { BackoffRow, ProxyRecord } from '../../api/types.ts';
import { formatCountdown, formatRelativeAgo } from '../../utils/format-countdown.ts';
import { kindFromUri } from '@floway-dev/proxy/url-kind';

const props = defineProps<{
  proxy: ProxyRecord;
  backoffsForProxy: BackoffRow[];
  upstreamNames: Map<string, string>;
}>();

defineEmits<{
  resetBackoffs: [];
  edit: [];
  delete: [];
}>();

// Live tick so backoff countdowns visibly decrement without a parent reload.
// 1s granularity matches the "in Xm Ys" precision we render.
const now = useNow({ interval: 1000 });

// Amber is reserved for backoff/warning everywhere in the dashboard, so no proxy-kind label uses it.
const kindBadgeClass = (kind: string) => {
  switch (kind) {
  case 'HTTP': return 'border-white/10 bg-white/5 text-gray-400';
  case 'HTTPS':
  case 'VLESS':
  case 'VLESS-WS': return 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan';
  case 'SOCKS5': return 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald';
  case 'SS':
  case 'SS-2022':
  case 'TROJAN':
  case 'REALITY': return 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet';
  default: return 'border-white/10 bg-white/5 text-gray-400';
  }
};

const kind = computed(() => kindFromUri(props.proxy.url));

// Strip userinfo before display: shadowsocks and trojan URIs embed the
// secret as the userinfo segment, and we do not want it leaking into a
// tooltip. URL parsing is preferred — but on parse failure we still scrub
// the raw string with a minimal scheme://userinfo@ regex so a malformed
// row (e.g. one our parser rejects but contains userinfo anyway) cannot
// leak credentials through the fallback path.
const urlPreview = computed(() => {
  const raw = props.proxy.url;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, '$1');
  }
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname === '/' ? '' : parsed.pathname}`;
});

const lastTestedAgo = computed(() => {
  if (props.proxy.last_tested_at == null) return null;
  return formatRelativeAgo(now.value.getTime() - props.proxy.last_tested_at * 1000);
});

const activeBackoffs = computed(() => {
  const nowSec = Math.floor(now.value.getTime() / 1000);
  // `>=` keeps the row visible during its expiry second so the countdown's
  // last tick renders the 'now' edge label. A strict `>` would hide the row
  // before the delta could go ≤ 0, leaving that label unreachable.
  return props.backoffsForProxy
    .filter(b => b.expires_at >= nowSec)
    .sort((a, b) => a.expires_at - b.expires_at);
});

// First active backoff drives the soonest-expiring countdown shown inline;
// the rest collapse into the +N more chip with a tooltip listing them all.
const soonestBackoff = computed(() => activeBackoffs.value[0] ?? null);
const extraBackoffCount = computed(() => Math.max(0, activeBackoffs.value.length - 1));
const backoffTooltip = computed(() => activeBackoffs.value
  .map(b => `${props.upstreamNames.get(b.upstream_id) ?? b.upstream_id}: in ${formatCountdown(b.expires_at * 1000 - now.value.getTime())}${b.last_error ? ` — ${b.last_error}` : ''}`)
  .join('\n'));
</script>

<template>
  <div class="flex items-center gap-3 rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2">
    <span
      class="shrink-0 rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
      :class="kindBadgeClass(kind)"
    >{{ kind }}</span>

    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2 min-w-0">
        <span class="truncate text-sm font-semibold text-white">{{ proxy.name }}</span>
        <span class="truncate text-xs text-gray-500" :title="urlPreview">{{ urlPreview }}</span>
      </div>
    </div>

    <div v-if="proxy.last_egress_ip || lastTestedAgo" class="hidden shrink-0 items-baseline gap-1.5 text-xs text-gray-500 md:flex">
      <span v-if="proxy.last_egress_ip" class="font-mono text-gray-400">{{ proxy.last_egress_ip }}</span>
      <span v-else class="italic">untested</span>
      <span v-if="lastTestedAgo" class="text-gray-600">{{ lastTestedAgo }}</span>
    </div>

    <button
      v-if="soonestBackoff"
      type="button"
      class="shrink-0 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-2 py-1 text-xs text-accent-amber transition-colors hover:bg-accent-amber/20"
      :title="`${backoffTooltip}\n\nClick to reset all backoffs.`"
      @click="$emit('resetBackoffs')"
    >
      backoff in {{ formatCountdown(soonestBackoff.expires_at * 1000 - now.getTime()) }}<span v-if="extraBackoffCount > 0"> +{{ extraBackoffCount }}</span>
    </button>

    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
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
        class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
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
</template>
