<script setup lang="ts">
import { computed } from 'vue';

import type { ModelAlias } from '../../api/types.ts';
import { formatAliasRulesInline } from '@floway-dev/protocols/common';

const props = defineProps<{
  alias: ModelAlias;
}>();

defineEmits<{
  edit: [];
  delete: [];
}>();

const rulesInline = computed(() => formatAliasRulesInline(props.alias.rules));
</script>

<template>
  <div class="flex items-start gap-3 rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2.5">
    <div class="min-w-0 flex-1 flex flex-col gap-1">
      <h4 v-if="alias.display_name" class="text-sm font-semibold text-white">{{ alias.display_name }}</h4>
      <p class="font-mono text-sm flex flex-wrap items-center gap-x-2">
        <span class="text-white break-all">{{ alias.alias }}</span>
        <span class="text-gray-600">&rarr;</span>
        <span class="text-gray-500 break-all">{{ alias.target_model_id }}</span>
      </p>
      <p v-if="rulesInline" class="text-sm text-gray-500">{{ rulesInline }}</p>
      <p
        v-if="!alias.visible_in_models_list"
        class="text-[10px] uppercase tracking-wide text-amber-300"
      >hidden from <code class="font-mono normal-case">/v1/models</code></p>
    </div>

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
