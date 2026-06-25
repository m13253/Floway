<script setup lang="ts">
import { computed } from 'vue';

import AliasRow from './AliasRow.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ModelAlias } from '../../api/types.ts';
import { useModelAliases } from '../../composables/useModelAliases.ts';
import { Spinner } from '@floway-dev/ui';

const emit = defineEmits<{
  'add': [];
  'edit': [record: ModelAlias];
  'changed': [];
}>();

const api = useApi();
const aliasesStore = useModelAliases();

const aliases = computed<ModelAlias[]>(() => aliasesStore.aliases.value ?? []);

const deleteAlias = async (record: ModelAlias) => {
  if (!window.confirm(`Delete alias "${record.alias}"?`)) return;
  const { error } = await callApi(() => api.api.aliases[':alias'].$delete({ param: { alias: record.alias } }));
  if (error) {
    window.alert(`Delete failed: ${error.message}`);
    return;
  }
  emit('changed');
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-white font-semibold mb-1">Aliases</h3>
        <p class="text-sm text-gray-400">
          Synthesized model ids that pin a target model plus a request-time rule overlay.
          Surfaced in <code class="rounded bg-white/[0.04] px-1">/v1/models</code> per the conflict policy.
        </p>
      </div>
      <button class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap" @click="emit('add')">Add Alias</button>
    </div>

    <p v-if="aliasesStore.error.value" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      Failed to load aliases: {{ aliasesStore.error.value }}
    </p>

    <p v-if="!aliasesStore.error.value && aliases.length === 0" class="text-sm text-gray-500">
      No aliases configured. Add one to expose a model id with locked reasoning, service tier, or other rule overrides.
    </p>

    <div v-else-if="aliases.length > 0" class="space-y-2">
      <AliasRow
        v-for="alias in aliases"
        :key="alias.alias"
        :alias="alias"
        @edit="emit('edit', alias)"
        @delete="deleteAlias(alias)"
      />
    </div>

    <Spinner v-if="aliasesStore.loading.value && aliases.length > 0" class="mt-3 h-4 w-4 text-gray-500" />
  </div>
</template>
