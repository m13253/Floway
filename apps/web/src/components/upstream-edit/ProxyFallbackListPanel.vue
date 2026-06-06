<script setup lang="ts">
// Per-upstream proxy fallback list editor. Lives inside UpstreamConfigPanel,
// not its own card — the surrounding aside already provides the card frame.
// Each entry is either a proxy id or the literal sentinel `direct`. An empty
// list defers to the gateway's default behaviour ("always direct").

import { useNow } from '@vueuse/core';
import { computed } from 'vue';

import type { BackoffRow, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';

const DIRECT = 'direct';

const props = defineProps<{
  modelValue: string[];
  // null in create mode — backoff rows are keyed on a saved upstream id, so
  // there is nothing to render until the upstream exists.
  upstreamId: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [list: string[]];
}>();

const { proxies, backoffs } = useProxiesStore();

const proxiesById = computed<Map<string, ProxyRecord>>(() => {
  const map = new Map<string, ProxyRecord>();
  for (const p of proxies.value ?? []) map.set(p.id, p);
  return map;
});

const proxiesNotInList = computed<ProxyRecord[]>(() => {
  const used = new Set(props.modelValue);
  return (proxies.value ?? []).filter(p => !used.has(p.id));
});

const directInList = computed(() => props.modelValue.includes(DIRECT));

const labelFor = (entry: string): string => {
  if (entry === DIRECT) return 'direct';
  return proxiesById.value.get(entry)?.name ?? entry;
};

// Live tick so the badge countdown ticks visibly without the parent reloading.
const now = useNow({ interval: 1000 });

const backoffsByProxyId = computed<Map<string, BackoffRow[]>>(() => {
  const map = new Map<string, BackoffRow[]>();
  for (const row of backoffs.value ?? []) {
    const list = map.get(row.proxy_id);
    if (list) list.push(row);
    else map.set(row.proxy_id, [row]);
  }
  return map;
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

interface ActiveBackoff {
  expiresIn: string;
  failCount: number;
  lastError: string | null;
}

// Resolve every list entry's active backoff once per tick. Recomputed via
// `now` so the countdown label refreshes every second; entries without a
// matching row map to null.
const activeBackoffByEntry = computed<Map<string, ActiveBackoff | null>>(() => {
  const map = new Map<string, ActiveBackoff | null>();
  if (props.upstreamId === null) {
    for (const entry of props.modelValue) map.set(entry, null);
    return map;
  }
  // expires_at is unix seconds; now is ms.
  const nowSec = Math.floor(now.value.getTime() / 1000);
  for (const entry of props.modelValue) {
    if (entry === DIRECT) { map.set(entry, null); continue; }
    const rows = backoffsByProxyId.value.get(entry);
    const row = rows?.find(r => r.upstream_id === props.upstreamId && r.expires_at > nowSec);
    map.set(entry, row
      ? { expiresIn: formatCountdown((row.expires_at - nowSec) * 1000), failCount: row.fail_count, lastError: row.last_error }
      : null);
  }
  return map;
});

const removeAt = (index: number) => {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit('update:modelValue', next);
};

const moveUp = (index: number) => {
  if (index <= 0) return;
  const next = [...props.modelValue];
  const tmp = next[index]!;
  next[index] = next[index - 1]!;
  next[index - 1] = tmp;
  emit('update:modelValue', next);
};

const moveDown = (index: number) => {
  if (index >= props.modelValue.length - 1) return;
  const next = [...props.modelValue];
  const tmp = next[index]!;
  next[index] = next[index + 1]!;
  next[index + 1] = tmp;
  emit('update:modelValue', next);
};

// Native <select> doubles as a one-shot picker: any non-empty value gets
// pushed onto the list, then we reset back to the placeholder option so the
// next pick fires another change event.
const onAddSelection = (event: Event) => {
  const select = event.target as HTMLSelectElement;
  const value = select.value;
  if (!value) return;
  emit('update:modelValue', [...props.modelValue, value]);
  select.value = '';
};
</script>

<template>
  <section>
    <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
      Proxy Fallback List <span class="text-accent-cyan">({{ modelValue.length }})</span>
    </p>

    <div v-if="modelValue.length === 0" class="rounded-md border border-dashed border-white/[0.08] bg-surface-900/40 px-3 py-2.5 text-xs text-gray-500">
      No fallback list configured — defaults to direct.
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="(entry, index) in modelValue"
        :key="`${entry}-${index}`"
        class="flex items-center gap-2 rounded-md border border-white/5 bg-surface-900/40 px-3 py-2 text-sm"
      >
        <div class="flex shrink-0 flex-col">
          <button
            type="button"
            class="inline-flex h-4 w-5 items-center justify-center rounded text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
            :disabled="index === 0"
            aria-label="Move entry up"
            title="Move up"
            @click="moveUp(index)"
          >
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            class="inline-flex h-4 w-5 items-center justify-center rounded text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
            :disabled="index === modelValue.length - 1"
            aria-label="Move entry down"
            title="Move down"
            @click="moveDown(index)"
          >
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        <span
          class="min-w-0 flex-1 truncate"
          :class="entry === DIRECT ? 'font-mono text-gray-300' : 'text-white'"
          :title="entry === DIRECT ? 'No proxy — connect directly' : entry"
        >{{ labelFor(entry) }}</span>

        <span
          v-if="activeBackoffByEntry.get(entry)"
          class="shrink-0 rounded border border-accent-amber/30 bg-accent-amber/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-amber"
          :title="activeBackoffByEntry.get(entry)?.lastError ?? undefined"
        >
          in backoff ({{ activeBackoffByEntry.get(entry)?.expiresIn }}, {{ activeBackoffByEntry.get(entry)?.failCount }}
          fail{{ activeBackoffByEntry.get(entry)?.failCount === 1 ? '' : 's' }})
        </span>

        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          aria-label="Remove entry"
          title="Remove"
          @click="removeAt(index)"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </li>
    </ul>

    <div class="mt-2">
      <select
        class="w-full rounded-md border border-white/5 bg-surface-900/40 px-3 py-2 text-sm text-gray-300 transition-colors hover:border-white/10 focus:border-accent-cyan/40 focus:outline-none"
        :value="''"
        @change="onAddSelection"
      >
        <option value="">+ Add proxy</option>
        <option value="direct" :disabled="directInList">direct</option>
        <option v-for="p in proxiesNotInList" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
  </section>
</template>
