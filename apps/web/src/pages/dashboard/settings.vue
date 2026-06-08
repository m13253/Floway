<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi, useApi } from '../../api/client.ts';
import type { SearchConfig } from '../../api/types.ts';
import { useModelsStore as useModelsStoreForLoader } from '../../composables/useModels.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../composables/useUpstreams.ts';
import { useAuthStore as useAuthStoreForLoader } from '../../stores/auth.ts';

const defaultSearchConfig: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
};

export const useSettingsPageData = defineBasicLoader(async () => {
  const auth = useAuthStoreForLoader();
  if (!auth.isAdmin) {
    // Non-admin users land on this page only for the My Account panel; the
    // admin-only data fetches would 403 and clear their session.
    return { searchConfig: defaultSearchConfig, searchConfigError: null };
  }
  const api = useApi();
  const [searchRes] = await Promise.all([
    callApi<SearchConfig>(() => api.api['search-config'].$get()),
    useUpstreamsStoreForLoader().load(),
    useModelsStoreForLoader().load(),
  ]);
  return {
    searchConfig: searchRes.data ?? defaultSearchConfig,
    searchConfigError: searchRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import type { UpstreamRecord } from '../../api/types.ts';
import PasswordDialog from '../../components/users/PasswordDialog.vue';
import ApiEndpointsSection from '../../components/settings/ApiEndpointsSection.vue';
import ExportSection from '../../components/settings/ExportSection.vue';
import ImportSection from '../../components/settings/ImportSection.vue';
import MyAccountCard from '../../components/settings/MyAccountCard.vue';
import SearchConfigSection from '../../components/settings/SearchConfigSection.vue';
import UpstreamsSettingsCard from '../../components/settings/UpstreamsSettingsCard.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { useAuthStore } from '../../stores/auth.ts';

const router = useRouter();
const store = useUpstreamsStore();
const { upstreams, loading: storeLoading, error: storeError, load } = store;
const modelsStore = useModelsStore();
const settingsData = useSettingsPageData();
const auth = useAuthStore();

// Local copy sorted by sort_order; the child card emits a reordered array
// via update:ordered, and reloadAll re-syncs from the store after PATCH.
const ordered = ref<UpstreamRecord[]>([]);
watch(upstreams, list => {
  ordered.value = list ? [...list].sort((a, b) => a.sort_order - b.sort_order) : [];
}, { immediate: true });

const reloadAll = async () => {
  await Promise.all([load(), modelsStore.load()]);
};

const passwordDrawerOpen = ref(false);
const passwordToast = ref<string | null>(null);

const onPasswordChanged = () => {
  passwordToast.value = 'Password updated. Other devices have been signed out.';
  window.setTimeout(() => { passwordToast.value = null; }, 4000);
};
</script>

<template>
  <div>
    <div v-if="storeError && auth.isAdmin" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ storeError }}
    </div>
    <div v-if="passwordToast" class="mb-4 rounded-md border border-accent-emerald/40 bg-accent-emerald/10 px-3 py-2 text-sm text-accent-emerald">
      {{ passwordToast }}
    </div>

    <MyAccountCard
      v-if="!auth.isAdmin"
      :username="auth.currentUser!.username"
      role-label="Standard user"
      @change-password="passwordDrawerOpen = true"
    />

    <div v-if="auth.isAdmin" class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div class="flex flex-col gap-5">
        <UpstreamsSettingsCard
          v-model:ordered="ordered"
          :loading="storeLoading"
          :models="modelsStore.models.value"
          @add="() => router.push('/dashboard/upstreams/new')"
          @edit="(record: UpstreamRecord) => router.push(`/dashboard/upstreams/${record.id}`)"
          @changed="reloadAll"
        />
        <SearchConfigSection
          :initial-config="settingsData.data.value.searchConfig"
          :initial-error="settingsData.data.value.searchConfigError"
        />
      </div>

      <div class="flex flex-col gap-5">
        <MyAccountCard
          :username="auth.currentUser!.username"
          role-label="Administrator"
          @change-password="passwordDrawerOpen = true"
        />
        <ApiEndpointsSection />
        <div class="glass-card p-5 sm:p-6 animate-in delay-2">
          <ExportSection :framed="false" />
          <div class="my-6 border-t border-white/[0.06]" />
          <ImportSection :framed="false" />
        </div>
      </div>
    </div>

    <PasswordDialog
      v-model:open="passwordDrawerOpen"
      mode="self"
      @saved="onPasswordChanged"
    />
  </div>
</template>
