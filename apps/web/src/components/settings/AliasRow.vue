<script setup lang="ts">
// One alias rendered as a two-line block in the Settings card. The action
// cluster sits right-aligned and reserves the leftmost slot for the
// alias-level warning icon — when no warning is firing the slot collapses
// to zero width, so the edit and delete buttons keep the same on-screen
// position whether or not a warning is present.

import { computed } from 'vue';

import type { ControlPlaneModel, ModelAlias } from '../../api/types.ts';
import { aliasHasShadowWarning, computeShadowWarning } from '../alias-edit/warnings.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import { Tooltip } from '@floway-dev/ui';

const props = defineProps<{
  alias: ModelAlias;
  models: readonly ControlPlaneModel[] | null;
}>();

defineEmits<{
  edit: [];
  delete: [];
}>();

// Title resolution mirrors the spec's derivation rule: an operator-set
// `display_name` always wins; falling back to the single-target compose
// helper or to the alias `name` when multi-target.
const title = computed(() => {
  if (props.alias.display_name !== null) return props.alias.display_name;
  if (props.alias.targets.length === 1) {
    const t = props.alias.targets[0];
    return composeAliasDisplayName(t.target_model_id, t.rules);
  }
  return props.alias.name;
});

const caption = computed(() => {
  const parts: string[] = [
    props.alias.name,
    `${props.alias.targets.length} target${props.alias.targets.length === 1 ? '' : 's'}`,
    props.alias.selection,
  ];
  if (!props.alias.visible_in_models_list) parts.push('hidden from /v1/models');
  return parts.join(' · ');
});

const shadowWarning = computed(() => computeShadowWarning(props.alias.name, props.alias.targets, props.models));
const hasShadow = computed(() => aliasHasShadowWarning(props.alias, props.models));
const shadowTooltip = computed(() => {
  const w = shadowWarning.value;
  if (!w) return '';
  const label = w.shadowedDisplayName !== null ? `${w.shadowedId} (${w.shadowedDisplayName})` : w.shadowedId;
  return `Alias name shadows a real model id: ${label}`;
});
</script>

<template>
  <div class="rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2.5">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h4 class="truncate text-sm font-semibold text-white">{{ title }}</h4>
        <p class="mt-0.5 truncate font-mono text-xs text-gray-500">{{ caption }}</p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Tooltip v-if="hasShadow" :content="shadowTooltip">
          <span
            class="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-400"
            aria-label="Alias warning"
          >
            <i class="i-lucide-alert-triangle size-4" />
          </span>
        </Tooltip>
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
  </div>
</template>
