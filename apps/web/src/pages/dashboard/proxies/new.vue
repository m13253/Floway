<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../../composables/useUpstreams.ts';

// Pre-warm upstreams so post-save navigation to /dashboard/proxies/:id renders without flicker.
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
