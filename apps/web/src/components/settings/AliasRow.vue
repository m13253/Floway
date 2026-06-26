<script setup lang="ts">
import { computed } from 'vue';

import type { ModelAlias } from '../../api/types.ts';
import { formatAliasRuleBadges } from '@floway-dev/protocols/common';

const props = defineProps<{
  alias: ModelAlias;
}>();

defineEmits<{
  edit: [];
  delete: [];
}>();

// Effective label: operator-set display name when present, otherwise fall
// back to the alias id itself. The "→ target" annotation is rendered
// alongside the label rather than substituted in so an operator who picks a
// long display name still sees what the alias points at.
const labelText = computed(() => props.alias.display_name ?? props.alias.alias);

const badges = computed(() => formatAliasRuleBadges(props.alias.rules));
</script>

<template>
  <div class="flex items-center gap-3 rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2">
    <div class="min-w-0 flex-1 truncate">
      <span class="font-mono text-xs text-gray-500">{{ alias.alias }}</span>
      <span class="ml-2 text-sm font-semibold text-white">{{ labelText }}</span>
      <span class="ml-2 text-xs text-gray-500">&rarr; {{ alias.target_model_id }}</span>
    </div>

    <div v-if="alias.upstream_ids.length > 0" class="hidden shrink-0 items-center gap-1 sm:flex">
      <span
        v-for="id in alias.upstream_ids"
        :key="id"
        class="rounded border border-white/10 bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] text-gray-400"
      >{{ id }}</span>
    </div>

    <div v-if="badges.length > 0" class="hidden shrink-0 items-center gap-1 sm:flex">
      <span
        v-for="badge in badges"
        :key="badge.label"
        class="rounded border border-white/10 bg-white/[0.02] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400"
      >
        {{ badge.label }}<template v-if="badge.value !== undefined">: <span class="text-gray-300 normal-case">{{ badge.value }}</span></template>
      </span>
    </div>

    <span
      v-if="!alias.visible_in_models_list"
      class="hidden shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300 sm:inline"
      title="Hidden from /v1/models"
    >hidden</span>

    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
        aria-label="Edit alias"
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
        aria-label="Delete alias"
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
