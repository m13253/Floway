<script setup lang="ts">
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { onScopeDispose, useTemplateRef, watch } from 'vue';

import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { Badge, OverlayScrollbars, Spinner } from '@floway-dev/ui';

dayjs.extend(relativeTime);

const props = defineProps<{
  records: DumpMetadata[];
  loading: boolean;
  error: string | null;
}>();

const selectedId = defineModel<string | null>('selectedId');

const emit = defineEmits<{ loadOlder: [] }>();

const sentinel = useTemplateRef<HTMLElement>('sentinel');

let observer: IntersectionObserver | null = null;

const observeSentinel = (el: HTMLElement | null) => {
  observer?.disconnect();
  observer = null;
  if (!el) return;
  observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) emit('loadOlder');
  }, { rootMargin: '200px' });
  observer.observe(el);
};

watch(sentinel, observeSentinel);
onScopeDispose(() => observer?.disconnect());

const truncatePath = (path: string) => path.length <= 56 ? path : `${path.slice(0, 53)}…`;

const statusTone = (status: number): 'emerald' | 'amber' | 'rose' | 'zinc' => {
  if (status === 0) return 'rose';
  if (status >= 500) return 'rose';
  if (status >= 400) return 'amber';
  if (status >= 200 && status < 300) return 'emerald';
  return 'zinc';
};

const statusLabel = (status: number) => status === 0 ? 'ERR' : String(status);

const tokenSummary = (r: DumpMetadata): string | null => {
  const inTok = r.inputTokens;
  const outTok = r.outputTokens;
  if (inTok === null && outTok === null) return null;
  return `${inTok ?? 0} in · ${outTok ?? 0} out`;
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
};

const isFailed = (r: DumpMetadata) => r.status === 0 || r.status >= 400 || r.error !== null;

const onSelect = (id: string) => { selectedId.value = id; };

// Re-observe when records grow so the IntersectionObserver fires repeatedly
// instead of only the first time the sentinel scrolls into view.
watch(() => props.records.length, () => {
  if (sentinel.value) observeSentinel(sentinel.value);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b border-white/[0.05] px-4 py-3">
      <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Requests</span>
      <span v-if="loading" class="flex items-center gap-1.5 text-xs text-gray-500">
        <Spinner class="size-3" /> Loading…
      </span>
      <span v-else class="text-xs text-gray-600">{{ records.length }}</span>
    </header>

    <div v-if="error" class="m-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <p v-if="!loading && records.length === 0 && !error" class="px-4 py-6 text-center text-sm text-gray-500">
      No requests recorded yet.
    </p>

    <OverlayScrollbars v-else class="min-h-0 flex-1" no-tabindex>
      <ul class="divide-y divide-white/[0.04]">
        <li
          v-for="r in records"
          :key="r.id"
          class="cursor-pointer px-4 py-3 transition-colors"
          :class="[
            selectedId === r.id ? 'bg-accent-cyan/8' : 'hover:bg-white/[0.02]',
            isFailed(r) ? 'bg-accent-rose/[0.04]' : '',
          ]"
          @click="onSelect(r.id)"
        >
          <div class="flex items-center gap-2 text-xs">
            <Badge :tone="statusTone(r.status)" size="sm">{{ statusLabel(r.status) }}</Badge>
            <span class="font-mono font-semibold text-gray-300">{{ r.method }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-gray-400" :title="r.path">{{ truncatePath(r.path) }}</span>
            <span class="shrink-0 text-gray-600" :title="dayjs(r.startedAt).format('YYYY-MM-DD HH:mm:ss')">
              {{ dayjs(r.startedAt).fromNow(true) }}
            </span>
          </div>

          <div class="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
            <span v-if="r.model" class="font-mono">{{ r.model }}</span>
            <span>{{ formatDuration(r.durationMs) }}</span>
            <span v-if="tokenSummary(r)">{{ tokenSummary(r) }}</span>
            <span v-if="r.upstream" class="ml-auto truncate text-gray-600">{{ r.upstream }}</span>
          </div>

          <p v-if="r.error" class="mt-1 truncate text-[11px] text-accent-rose" :title="r.error">{{ r.error }}</p>
        </li>
      </ul>

      <div ref="sentinel" class="h-4" />
    </OverlayScrollbars>
  </div>
</template>
