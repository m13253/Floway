<script lang="ts">
import { useEventListener } from '@vueuse/core';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import RecordDetail from '../../components/dump/RecordDetail.vue';
import RequestList from '../../components/dump/RequestList.vue';
import { useDumpSubscription } from '../../composables/useDumpSubscription.ts';
import { useHashRef } from '../../composables/useHashRef.ts';

export const useRequestsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const keysRes = await callApi<ApiKey[]>(() => api.api.keys.$get());
  return {
    keys: keysRes.error ? [] : keysRes.data,
    error: keysRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">
const api = useApi();
const initialData = useRequestsPageData();

const keys = ref<ApiKey[]>(initialData.data.value.keys);
const loadError = ref<string | null>(initialData.data.value.error);

const dumpKeys = computed(() => keys.value.filter(k => k.dump_retention_seconds !== null));

const selectedKeyId = ref<string>(dumpKeys.value[0]?.id ?? '');
const selectedRecordId = useHashRef();

const subscription = useDumpSubscription(selectedKeyId);

// Single setter for swapping the active key: the selected record id belongs
// to the previous key and would 404 against the new one, so we null it in
// the same tick. This eliminates the transient (newKeyId, oldRecordId) pair
// the child detail component would otherwise see if Vue's watcher order
// changed.
const selectKey = (id: string) => {
  selectedKeyId.value = id;
  selectedRecordId.value = null;
};

// Refetch the keys list when the operator switches back to this tab so a
// retention toggle made elsewhere reflects without a full reload.
const reloadKeys = async () => {
  const res = await callApi<ApiKey[]>(() => api.api.keys.$get());
  if (res.error) {
    loadError.value = res.error.message;
    return;
  }
  keys.value = res.data;
  loadError.value = null;
};

useEventListener(window, 'focus', () => { void reloadKeys(); });

// Reconcile selectedKeyId when the dump-enabled set changes: if the current
// pick is no longer in the list, fall back to the first available (or '').
watch(dumpKeys, next => {
  if (selectedKeyId.value === '') {
    selectKey(next[0]?.id ?? '');
    return;
  }
  if (!next.some(k => k.id === selectedKeyId.value)) {
    selectKey(next[0]?.id ?? '');
  }
});
</script>

<template>
  <div>
    <div v-if="loadError" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ loadError }}
    </div>

    <div class="glass-card animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
      <aside class="flex max-h-72 w-full shrink-0 flex-col border-b border-white/[0.06] lg:max-h-none lg:w-90 lg:border-b-0 lg:border-r">
        <div class="border-b border-white/[0.06] p-3">
          <select
            v-if="dumpKeys.length > 0"
            :value="selectedKeyId"
            class="w-full bg-transparent text-xs text-gray-200 focus:outline-none"
            @change="selectKey(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="k in dumpKeys" :key="k.id" :value="k.id">
              {{ k.name }} ({{ k.key.slice(-4) }})
            </option>
          </select>
          <p v-else class="text-xs text-gray-500">No dump-enabled keys.</p>
        </div>

        <div v-if="dumpKeys.length === 0" class="px-4 py-6 text-center text-xs text-gray-500">
          Enable request dump retention on an API key to start capturing requests.
          <RouterLink to="/dashboard/keys" class="mt-2 block text-accent-cyan hover:underline">
            Go to API Keys →
          </RouterLink>
        </div>

        <RequestList
          v-else
          :records="subscription.records.value"
          :loading="subscription.loading.value"
          :error="subscription.error.value"
          v-model:selected-id="selectedRecordId"
          @load-older="subscription.loadOlder"
        />
      </aside>

      <div class="min-w-0 flex-1">
        <RecordDetail :key-id="selectedKeyId" :record-id="selectedRecordId" />
      </div>
    </div>
  </div>
</template>
