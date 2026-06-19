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

const statusTone = (status: number): 'emerald' | 'amber' | 'rose' | 'zinc' => {
  if (status === 0 || status >= 500) return 'rose';
  if (status >= 400) return 'amber';
  if (status >= 200 && status < 300) return 'emerald';
  return 'zinc';
};

const statusLabel = (status: number) => status === 0 ? 'ERR' : String(status);

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
};

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// Show "1.2 M" / "12.3 K" / plain integer.
const formatTokens = (n: number) => {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)} K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} K`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return `${Math.round(n / 1_000_000)} M`;
};

const totalTokens = (r: DumpMetadata): number | null => {
  if (r.inputTokens === null && r.outputTokens === null) return null;
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
};

// Tone classes by upstream kind; no badge, just a tinted label.
const providerColorClass = (kind: string): string => {
  if (kind === 'copilot') return 'text-accent-cyan';
  if (kind === 'azure') return 'text-accent-emerald';
  if (kind === 'custom') return 'text-accent-amber';
  if (kind === 'codex') return 'text-accent-cyan';
  return 'text-gray-400';
};

const isFailed = (r: DumpMetadata) => r.status === 0 || r.status >= 400 || r.error !== null;

const onSelect = (id: string) => { selectedId.value = id; };

watch(() => props.records.length, () => {
  if (sentinel.value) observeSentinel(sentinel.value);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="error" class="m-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <div v-if="loading && records.length === 0" class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500">
      <Spinner class="size-3" /> Loading…
    </div>

    <p v-if="!loading && records.length === 0 && !error" class="px-4 py-8 text-center text-sm text-gray-500">
      No requests recorded yet.
    </p>

    <OverlayScrollbars v-else class="min-h-0 flex-1" no-tabindex>
      <ul class="divide-y divide-white/[0.04]">
        <li
          v-for="r in records"
          :key="r.id"
          class="cursor-pointer px-4 py-2.5 transition-colors"
          :class="[
            selectedId === r.id ? 'bg-accent-cyan/10' : 'hover:bg-white/[0.02]',
            isFailed(r) ? 'bg-accent-rose/[0.04]' : '',
          ]"
          @click="onSelect(r.id)"
        >
          <!-- Line 1: status + (model | "Unknown") + time. Model is the most
               operator-relevant identifier so it takes the prominent slot;
               when accounting didn't resolve one (e.g. a 4xx before the
               upstream attempt) we show "Unknown" in a non-mono font as a
               clear "no value" cue. Method is recorded server-side but not
               shown — every captured endpoint is POST, so it adds no signal
               in the list. -->
          <div class="flex items-center gap-2 text-xs">
            <Badge :tone="statusTone(r.status)" size="sm">{{ statusLabel(r.status) }}</Badge>
            <span
              v-if="r.model"
              class="min-w-0 flex-1 truncate font-mono text-gray-400"
              :title="r.model"
            >{{ r.model }}</span>
            <span v-else class="min-w-0 flex-1 truncate text-gray-500">Unknown</span>
            <span class="shrink-0 text-[11px] text-gray-600" :title="dayjs(r.startedAt).format('YYYY-MM-DD HH:mm:ss')">
              {{ dayjs(r.startedAt).fromNow() }}
            </span>
          </div>

          <!-- Line 2: path (left, secondary) and metrics (right). -->
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
            <span class="mr-auto min-w-0 truncate font-mono" :title="r.path">{{ r.path }}</span>
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="inline-flex items-center gap-1" :title="`${r.durationMs} ms`">
                <i class="i-lucide-timer size-3" />{{ formatDuration(r.durationMs) }}
              </span>
              <span class="inline-flex items-center gap-1 font-mono" :title="`request body ${r.requestBytes} bytes`">
                <i class="i-lucide-arrow-up size-3" />{{ formatBytes(r.requestBytes) }}
              </span>
              <span class="inline-flex items-center gap-1 font-mono" :title="`response body ${r.responseBytes} bytes`">
                <i class="i-lucide-arrow-down size-3" />{{ formatBytes(r.responseBytes) }}
              </span>
            </span>
          </div>

          <!-- Line 3 (optional): provider name (colored) + total tokens -->
          <div
            v-if="r.upstream || totalTokens(r) !== null"
            class="mt-1 flex items-center justify-between gap-3 text-[11px]"
          >
            <span
              v-if="r.upstream"
              class="min-w-0 truncate"
              :class="providerColorClass(r.upstream.kind)"
              :title="`${r.upstream.kind} · ${r.upstream.id}`"
            >{{ r.upstream.name }}</span>
            <span v-else />
            <span v-if="totalTokens(r) !== null" class="shrink-0 font-mono text-gray-500">
              {{ formatTokens(totalTokens(r)!) }} tokens
            </span>
          </div>

          <p v-if="r.error" class="mt-1 truncate text-[11px] text-accent-rose" :title="r.error">{{ r.error }}</p>
        </li>
      </ul>

      <div ref="sentinel" class="h-4" />
    </OverlayScrollbars>
  </div>
</template>
