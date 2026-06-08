<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useProxiesStore as useProxiesStoreForLoader } from '../../../composables/useProxies.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../../composables/useUpstreams.ts';

// The loader populates the proxies and upstreams stores before the page
// mounts. The page reads the live row out of the store via a `computed`,
// so server-side state changes (admin reset, sibling test, etc.)
// propagate into props.record on the next store reload.
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
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ProxyEditPage from '../../../components/proxy-edit/ProxyEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';

definePage({ meta: { requiresAdmin: true } });

useEditProxyData();
const route = useRoute('/dashboard/proxies/[id]');
const router = useRouter();
const store = useProxiesStore();

const record = computed(() => (store.proxies.value ?? []).find(p => p.id === route.params.id) ?? null);

// Redirect both at mount AND on subsequent transitions to null so a row
// deleted by a sibling action while this page is mounted does not leave
// the user staring at a blank glass card — the watcher takes them home.
const goBackToSettings = (): void => { void router.replace('/dashboard/settings'); };
watch(
  record,
  // Skip the redirect while the store is still loading for the first time.
  // store.proxies.value is null until load() resolves, so a null record
  // before that simply means "not loaded yet"; once the store is non-null
  // and our record is null, the row truly does not exist.
  next => { if (next === null && store.proxies.value !== null) goBackToSettings(); },
  { immediate: true },
);

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <!-- Surface a list-load failure as a clear error card so a deep-link to
       /dashboard/proxies/<id> doesn't silently bounce when the proxies
       endpoint errors. -->
  <div
    v-if="store.error.value && !record"
    class="glass-card p-5 sm:p-6 space-y-3 animate-in"
  >
    <h2 class="text-lg font-semibold text-white">Cannot load proxy</h2>
    <p class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ store.error.value }}
    </p>
    <button class="btn-secondary !py-2 !px-3 text-xs" @click="goBackToSettings">Back to settings</button>
  </div>
  <ProxyEditPage
    v-else-if="record"
    :key="record.id"
    mode="edit"
    :record="record"
    @saved="onSaved"
  />
</template>
