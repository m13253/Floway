<script setup lang="ts">
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { computed, onBeforeUnmount, useTemplateRef, watch } from 'vue';

import { rowTintClass, statusBadgeClass } from './badge.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

dayjs.extend(relativeTime);

const props = defineProps<{
  records: DumpMetadata[];
  loading: boolean;
  error: string | null;
}>();

const selectedId = defineModel<string | null>('selectedId');

const emit = defineEmits<{ loadOlder: [] }>();

const sentinelRef = useTemplateRef<HTMLDivElement>('sentinel');

// Single observer for the page lifetime. The sentinel only mounts inside the
// scroll shell (which is itself gated by loading/empty branches), so attach
// when the ref resolves rather than at onMounted — that way a slow first
// load still arms infinite scroll once the shell finally appears.
let observer: IntersectionObserver | null = null;

watch(sentinelRef, el => {
  observer?.disconnect();
  observer = null;
  if (!el) return;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) emit('loadOlder');
    }
  }, { rootMargin: '200px' });
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
};

const formatTokens = (n: number): string => {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

const upstreamKindTextClass = (kind: string | undefined): string => {
  switch (kind) {
  case 'copilot': return 'text-accent-cyan';
  case 'codex': return 'text-accent-violet';
  case 'azure': return 'text-accent-emerald';
  case 'custom': return 'text-accent-amber';
  case 'ollama': return 'text-accent-rose';
  default: return 'text-gray-500';
  }
};

const statusLabel = (status: number) => status === 0 ? 'ERR' : String(status);

// `inputTokens`/`outputTokens` are `null` when the upstream didn't report
// that dimension (preserved deliberately by capture-dump's token accounting).
// Collapsing both to 0 would conflate "not measured" with "zero tokens", so
// return null when neither side has a number and let the template render an
// em-dash for that case.
const totalTokens = (meta: DumpMetadata): number | null => {
  if (meta.inputTokens === null && meta.outputTokens === null) return null;
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
};

const relTime = (ms: number) => dayjs(ms).fromNow();
const fullTime = (ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm:ss');

const onRowKey = (id: string) => { selectedId.value = id; };

// Roving tabindex: only the currently-selected (or, when nothing is selected,
// the first) row is in the tab order. The listbox itself is one Tab stop;
// arrow keys move focus within it.
const rovingTabIndex = (record: DumpMetadata, position: number): 0 | -1 => {
  if (selectedId.value === record.id) return 0;
  if (selectedId.value === null && position === 0) return 0;
  return -1;
};

const moveSelection = (event: KeyboardEvent, delta: 1 | -1): void => {
  // The handler binds on each `<li>` so `currentTarget` is always that
  // element; arrow keys on edge rows just have no sibling to move to.
  const current = event.currentTarget as HTMLElement;
  const sibling = (delta === 1 ? current.nextElementSibling : current.previousElementSibling) as HTMLElement | null;
  if (!sibling) return;
  sibling.focus();
  selectedId.value = sibling.dataset.recordId!;
};

const showEmpty = computed(() => !props.loading && props.records.length === 0 && props.error === null);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="error" class="m-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <div v-if="loading && records.length === 0" class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500">
      <Spinner class="size-3.5" />
      Loading…
    </div>

    <div v-else-if="showEmpty" class="px-4 py-8 text-center text-xs text-gray-500">
      No requests recorded yet.
    </div>

    <OverlayScrollbars v-else class="min-h-0 flex-1">
      <ul class="divide-y divide-white/[0.03]" role="listbox" aria-label="Captured requests">
        <li
          v-for="(record, position) in records"
          :key="record.id"
          :tabindex="rovingTabIndex(record, position)"
          role="option"
          :aria-selected="selectedId === record.id"
          :data-record-id="record.id"
          class="cursor-pointer px-3 py-2.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent-cyan/60"
          :class="rowTintClass(record.status, record.error, selectedId === record.id)"
          @click="onRowKey(record.id)"
          @keydown.enter.prevent="onRowKey(record.id)"
          @keydown.space.prevent="onRowKey(record.id)"
          @keydown.up.prevent="moveSelection($event, -1)"
          @keydown.down.prevent="moveSelection($event, 1)"
        >
          <div class="flex items-center gap-2 text-xs">
            <span
              class="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none"
              :class="statusBadgeClass(record.status, record.error)"
            >
              {{ statusLabel(record.status) }}
            </span>
            <span
              class="min-w-0 truncate"
              :class="record.model ? 'font-mono text-gray-300' : 'text-gray-500'"
            >
              {{ record.model ?? 'Unknown' }}
            </span>
            <span class="ml-auto shrink-0 text-[11px] text-gray-500" :title="fullTime(record.startedAt)">
              {{ relTime(record.startedAt) }}
            </span>
          </div>

          <div class="mt-1 flex items-center gap-3 text-[11px]">
            <span class="min-w-0 flex-1 truncate font-mono text-gray-400" :title="`${record.method} ${record.path}`">
              {{ record.method }} {{ record.path }}
            </span>
            <span class="flex shrink-0 items-center gap-2.5 text-gray-500">
              <span class="inline-flex items-center gap-0.5" :title="`Duration ${record.durationMs}ms`">
                <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="13" r="8" />
                  <path d="M12 9v4l2 2" />
                  <path d="M9 2h6" />
                </svg>
                {{ formatDuration(record.durationMs) }}
              </span>
              <span class="inline-flex items-center gap-0.5" title="Request bytes">
                <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
                {{ formatBytes(record.requestBytes) }}
              </span>
              <span class="inline-flex items-center gap-0.5" title="Response bytes">
                <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14" />
                  <path d="m19 12-7 7-7-7" />
                </svg>
                {{ formatBytes(record.responseBytes) }}
              </span>
            </span>
          </div>

          <div class="mt-1 flex items-center gap-2 text-[11px]">
            <span :class="upstreamKindTextClass(record.upstream?.kind)" class="min-w-0 truncate">
              {{ record.upstream?.name ?? 'No upstream' }}
            </span>
            <span class="ml-auto shrink-0 text-gray-600">
              {{ totalTokens(record) === null ? '—' : `${formatTokens(totalTokens(record)!)} tok` }}
            </span>
          </div>

          <div
            v-if="record.error"
            class="mt-1 truncate text-[11px] text-accent-rose"
            :title="record.error"
          >
            {{ record.error }}
          </div>
        </li>
      </ul>
      <div ref="sentinel" class="h-px w-full" aria-hidden="true" />
    </OverlayScrollbars>
  </div>
</template>
