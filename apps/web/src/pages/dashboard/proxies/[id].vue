<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useProxiesStore as useProxiesStoreForLoader } from '../../../composables/useProxies.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../../composables/useUpstreams.ts';

// No GET /api/proxies/:id — look up the record from the list cache.
export const useEditProxyData = defineBasicLoader('/dashboard/proxies/[id]', async route => {
  const id = route.params.id;
  const proxiesStore = useProxiesStoreForLoader();
  await Promise.all([
    proxiesStore.load(),
    useUpstreamsStoreForLoader().load(),
  ]);
  const record = (proxiesStore.proxies.value ?? []).find(p => p.id === id) ?? null;
  return { record };
});
</script>

<script setup lang="ts">
import { useRouter } from 'vue-router';

import ProxyEditPage from '../../../components/proxy-edit/ProxyEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';

definePage({ meta: { requiresAdmin: true } });

const data = useEditProxyData();
const router = useRouter();
const store = useProxiesStore();

if (data.data.value.record === null) {
  void router.replace('/dashboard/settings');
}

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <ProxyEditPage
    v-if="data.data.value.record"
    :key="data.data.value.record.id"
    mode="edit"
    :record="data.data.value.record"
    @saved="onSaved"
  />
</template>
