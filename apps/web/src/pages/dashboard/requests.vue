<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import RecordDetail from '../../components/dump/RecordDetail.vue';
import RequestList from '../../components/dump/RequestList.vue';
import { useDumpSubscription } from '../../composables/useDumpSubscription.ts';
import { useHashRef } from '../../composables/useHashRef.ts';

export const useRequestsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const res = await callApi<ApiKey[]>(() => api.api.keys.$get());
  return { keys: res.data ?? [], keysError: res.error?.message ?? null };
});
</script>

<script setup lang="ts">
const initialData = useRequestsPageData();
// Refetch on window focus so a key created or had its dump retention toggled
// in another tab is reflected without a manual reload. `reload()` calls the
// same loader, so the binding above stays the single source of truth.
const onFocus = () => { void initialData.reload(); };
onMounted(() => window.addEventListener('focus', onFocus));
onUnmounted(() => window.removeEventListener('focus', onFocus));

const keys = computed(() => initialData.data.value.keys);
const dumpKeys = computed(() => keys.value.filter(k => k.dump_retention_seconds !== null));

const selectedKeyId = ref<string | null>(dumpKeys.value[0]?.id ?? null);
const selectedKeyIdReactive = computed(() => selectedKeyId.value ?? '');

// Focus refetch (or another tab toggling dump retention off on the selected
// key) can shrink `dumpKeys` out from under the selection. Reconcile to the
// first remaining dump-enabled key — `useDumpSubscription`'s keyId watcher
// then tears down the now-stale stream.
watch(dumpKeys, list => {
  if (selectedKeyId.value !== null && !list.some(k => k.id === selectedKeyId.value)) {
    selectedKeyId.value = list[0]?.id ?? null;
  }
});

const selectedId = useHashRef();
watch(selectedKeyId, () => { selectedId.value = null; });

const { records, loading, error, loadOlder } = useDumpSubscription(selectedKeyIdReactive);
</script>

<template>
  <div>
    <div
      v-if="initialData.data.value.keysError"
      class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose"
    >
      {{ initialData.data.value.keysError }}
    </div>

    <div class="glass-card animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
      <div class="max-h-56 w-full shrink-0 flex flex-col border-b border-white/[0.06] lg:max-h-none lg:w-90 lg:border-b-0 lg:border-r">
        <div class="border-b border-white/[0.06] p-3">
          <select
            v-model="selectedKeyId"
            :disabled="dumpKeys.length === 0"
            class="w-full bg-transparent border-none text-xs text-gray-200 focus:outline-none disabled:text-gray-500"
          >
            <option v-if="dumpKeys.length === 0" :value="null">
              (no key has dump retention set — enable it in API Keys)
            </option>
            <option v-for="k in dumpKeys" :key="k.id" :value="k.id">
              {{ k.name }} ({{ k.key.slice(-4) }})
            </option>
          </select>
        </div>

        <div v-if="selectedKeyId" class="flex min-h-0 flex-1">
          <RequestList
            v-model:selected-id="selectedId"
            class="flex-1 min-h-0"
            :records="records"
            :loading="loading"
            :error="error"
            @load-older="loadOlder"
          />
        </div>
        <p v-else class="px-4 py-8 text-center text-xs text-gray-600">
          Select a key with dump retention enabled to view its requests.
        </p>
      </div>

      <div class="flex-1 flex flex-col min-w-0 min-h-0">
        <template v-if="selectedKeyId">
          <RecordDetail :key-id="selectedKeyId" :record-id="selectedId" />
        </template>
        <div v-else class="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Select an API key on the left to view captured requests.
        </div>
      </div>
    </div>
  </div>
</template>
