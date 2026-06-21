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
  if (keysRes.error) {
    // Surface the loader error rather than swallowing it into an empty list:
    // "no dump-enabled keys" and "we failed to load the key list" are
    // different states and the operator needs to see which one this is.
    return { keys: null as ApiKey[] | null, error: keysRes.error.message };
  }
  return { keys: keysRes.data, error: null as string | null };
});
</script>

<script setup lang="ts">
const api = useApi();
const initialData = useRequestsPageData();

const keys = ref<ApiKey[] | null>(initialData.data.value.keys);
const loadError = ref<string | null>(initialData.data.value.error);

// `keys.value === null` means the API call failed — distinct from "loaded an
// empty list". Preserve the null so the picker UI stays gated and the load
// error surfaces via `loadError` above; only filter once we actually have a
// list to filter.
const dumpKeys = computed(() => keys.value === null ? null : keys.value.filter(k => k.dump_retention_seconds !== null));

const selectedKeyId = ref<string>(dumpKeys.value?.[0]?.id ?? '');
const selectedRecordId = useHashRef();

const subscription = useDumpSubscription(selectedKeyId);

// Single setter for swapping the active key: the selected record id belongs
// to the previous key and would 404 against the new one, so null it in the
// same tick.
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
// When the keys list itself failed to load (`dumpKeys === null`), leave the
// selection alone — the page renders the load-error block instead.
watch(dumpKeys, next => {
  if (next === null) return;
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
      <aside class="flex max-h-72 w-full min-h-0 shrink-0 flex-col border-b border-white/[0.06] lg:max-h-none lg:w-90 lg:border-b-0 lg:border-r">
        <div class="border-b border-white/[0.06] p-3">
          <select
            v-if="dumpKeys && dumpKeys.length > 0"
            :value="selectedKeyId"
            class="w-full bg-transparent text-xs text-gray-200 focus:outline-none"
            @change="selectKey(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="k in dumpKeys" :key="k.id" :value="k.id">
              {{ k.name }} ({{ k.key.slice(-4) }})
            </option>
          </select>
          <p v-else-if="dumpKeys" class="text-xs text-gray-500">No dump-enabled keys.</p>
        </div>

        <div v-if="dumpKeys && dumpKeys.length === 0" class="px-4 py-6 text-center text-xs text-gray-500">
          Enable request dump retention on an API key to start capturing requests.
          <RouterLink to="/dashboard/keys" class="mt-2 block text-accent-cyan hover:underline">
            Go to API Keys →
          </RouterLink>
        </div>

        <div v-else-if="dumpKeys" class="flex min-h-0 flex-1 flex-col">
          <RequestList
            :records="subscription.records.value"
            :loading="subscription.loading.value"
            :error="subscription.error.value"
            v-model:selected-id="selectedRecordId"
            @load-older="subscription.loadOlder"
          />
        </div>
      </aside>

      <div class="flex min-w-0 min-h-0 flex-1 flex-col">
        <div v-if="selectedKeyId === ''" class="flex h-full items-center justify-center px-6 text-center text-sm text-gray-600">
          Select an API key on the left to view captured requests.
        </div>
        <RecordDetail v-else :key-id="selectedKeyId" :record-id="selectedRecordId" />
      </div>
    </div>
  </div>
</template>
