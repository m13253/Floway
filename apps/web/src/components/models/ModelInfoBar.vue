<script setup lang="ts">
import { computed } from 'vue';

import type { ControlPlaneModel } from '../../api/types.ts';
import { providerBadgeClass, providerMeta } from '../upstreams/provider-meta.ts';
import { formatAliasRuleBadges } from '@floway-dev/protocols/common';

const props = defineProps<{
  model: ControlPlaneModel;
}>();

defineEmits<{ clear: [] }>();

const formatTokenLimit = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return n.toString();
};

// Alias-of badge: truncate the target list to the first three with a
// "+N more" tail when needed. Keeps the badge readable for aliases that
// fan out to a long fallback chain.
const aliasOfLabel = computed<string | null>(() => {
  const a = props.model.aliasedFrom;
  if (!a) return null;
  const ids = a.targets.map(t => t.target_model_id);
  if (ids.length <= 3) return `alias of: ${ids.join(', ')}`;
  return `alias of: ${ids.slice(0, 3).join(', ')} +${ids.length - 3} more`;
});

// Rule badge sequence. Single-target aliases keep the existing
// per-rule badges; multi-target aliases collapse the rule set into one
// "<field>: varies" pill per field configured on any target.
const ruleBadges = computed<{ label: string }[]>(() => {
  const a = props.model.aliasedFrom;
  if (!a) return [];
  if (a.targets.length === 1) return formatAliasRuleBadges(a.targets[0].rules);
  // Walk each target and bucket their badge labels by the field they
  // describe (the leading word of every badge — "low effort", "summary:
  // auto"). Any field that shows up in two distinct shapes collapses to
  // "<field>: varies".
  const byField = new Map<string, Set<string>>();
  for (const t of a.targets) {
    for (const badge of formatAliasRuleBadges(t.rules)) {
      const field = badge.label.includes(':') ? badge.label.split(':')[0].trim() : badge.label.split(' ').slice(1).join(' ').trim() || badge.label;
      const set = byField.get(field) ?? new Set<string>();
      set.add(badge.label);
      byField.set(field, set);
    }
  }
  return Array.from(byField.entries()).map(([field, set]) => ({
    label: set.size === 1 ? [...set][0] : `${field}: varies`,
  }));
});
</script>

<template>
  <div class="shrink-0 p-4 border-b border-white/[0.06]">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2">
          <h3 class="text-sm font-semibold text-white">{{ model.display_name ?? model.id }}</h3>
          <span
            v-if="(model.display_name ?? model.id) !== model.id"
            class="font-mono text-[11px] text-gray-500 break-all"
          >{{ model.id }}</span>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <span
            v-for="binding in model.upstreams"
            :key="binding.id"
            class="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
            :class="providerBadgeClass(binding.kind)"
            :title="providerMeta(binding.kind).label + ' · ' + binding.name"
          >{{ binding.name }}</span>
          <span v-if="model.limits?.max_context_window_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            context: {{ formatTokenLimit(model.limits.max_context_window_tokens) }}
          </span>
          <span v-if="model.limits?.max_prompt_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            prompt: {{ formatTokenLimit(model.limits.max_prompt_tokens) }}
          </span>
          <span v-if="model.limits?.max_output_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            output: {{ formatTokenLimit(model.limits.max_output_tokens) }}
          </span>
          <span v-if="aliasOfLabel" class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400">{{ aliasOfLabel }}</span>
          <span v-if="model.aliasedFrom" class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400">selection: {{ model.aliasedFrom.selection }}</span>
          <span
            v-for="badge in ruleBadges"
            :key="badge.label"
            class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400"
          >{{ badge.label }}</span>
        </div>
      </div>
      <button class="btn-ghost text-[11px] flex shrink-0 items-center gap-1" @click="$emit('clear')">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
        Clear
      </button>
    </div>
  </div>
</template>
