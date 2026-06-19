<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import RecordDetail from '../../../../components/dump/RecordDetail.vue';
import RequestList from '../../../../components/dump/RequestList.vue';
import { useDumpSubscription } from '../../../../composables/useDumpSubscription.ts';
import { useHashRef } from '../../../../composables/useHashRef.ts';

const route = useRoute('/dashboard/keys/[keyId]/requests');
const keyId = computed(() => route.params.keyId);
const selectedId = useHashRef();

watch(keyId, () => { selectedId.value = null; });

const { records, loading, error, loadOlder } = useDumpSubscription(keyId);
</script>

<template>
  <div class="flex min-h-[calc(100dvh-12rem)] flex-col">
    <div class="mb-4 flex items-center gap-2 text-xs text-gray-500">
      <RouterLink to="/dashboard/keys" class="hover:text-accent-cyan">API Keys</RouterLink>
      <span>/</span>
      <span class="font-mono text-gray-400">{{ keyId }}</span>
      <span>/</span>
      <span class="text-gray-400">Requests</span>
    </div>

    <div class="glass-card flex min-h-0 flex-1 overflow-hidden">
      <RequestList
        v-model:selected-id="selectedId"
        class="w-1/3 min-w-[320px] border-r border-white/[0.05]"
        :records="records"
        :loading="loading"
        :error="error"
        @load-older="loadOlder"
      />
      <RecordDetail class="flex-1" :key-id="keyId" :record-id="selectedId" />
    </div>
  </div>
</template>
