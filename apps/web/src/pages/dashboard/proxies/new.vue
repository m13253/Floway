<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../../composables/useUpstreams.ts';

// The create page only needs the upstream list pre-warmed so the post-save
// navigation into /dashboard/proxies/:id can render its (initially empty)
// backoff section without a flicker.
export const useNewProxyData = defineBasicLoader(async () => {
  await useUpstreamsStoreForLoader().load();
  return {};
});
</script>

<script setup lang="ts">
import ProxyEditPage from '../../../components/proxy-edit/ProxyEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';

definePage({ meta: { requiresAdmin: true } });

useNewProxyData();
const store = useProxiesStore();

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <ProxyEditPage mode="create" :record="null" @saved="onSaved" />
</template>
