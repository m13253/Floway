<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import ProxyEditPage from '../../../components/proxy-edit/ProxyEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';

// Pre-warm upstreams so post-save navigation to /dashboard/proxies/:id renders without flicker.
export const useNewProxyData = defineBasicLoader(async () => {
  await useUpstreamsStore().load();
  return {};
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

// The loader's promise resolves before the page mounts (Suspense awaits
// it for us); calling it here just registers the route's data dependency.
void useNewProxyData();
const store = useProxiesStore();

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <ProxyEditPage mode="create" :record="null" @saved="onSaved" />
</template>
