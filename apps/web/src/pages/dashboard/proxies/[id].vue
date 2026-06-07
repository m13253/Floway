<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useProxiesStore as useProxiesStoreForLoader } from '../../../composables/useProxies.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../../composables/useUpstreams.ts';

// The loader's job is to ensure the stores are populated before the page
// mounts; it does NOT freeze a record reference. The page reads the live
// row out of the store via a `computed`, so server-side state changes
// (admin reset, sibling test, etc.) propagate into props.record on the
// next store reload — which is what the override-clearing watcher in
// ProxyEditPage relies on to drop a stale local Test result.
export const useEditProxyData = defineBasicLoader('/dashboard/proxies/[id]', async () => {
  const proxiesStore = useProxiesStoreForLoader();
  await Promise.all([
    proxiesStore.load(),
    useUpstreamsStoreForLoader().load(),
  ]);
  return {};
});
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ProxyEditPage from '../../../components/proxy-edit/ProxyEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';

definePage({ meta: { requiresAdmin: true } });

useEditProxyData();
const route = useRoute();
const router = useRouter();
const store = useProxiesStore();

const record = computed(() => {
  const params = route.params as Record<string, string | string[]>;
  const raw = params.id;
  const id = Array.isArray(raw) ? raw[0]! : raw;
  return (store.proxies.value ?? []).find(p => p.id === id) ?? null;
});

if (record.value === null) {
  void router.replace('/dashboard/settings');
}

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <ProxyEditPage
    v-if="record"
    :key="record.id"
    mode="edit"
    :record="record"
    @saved="onSaved"
  />
</template>
