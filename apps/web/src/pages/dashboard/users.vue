<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi as callApiForLoader, useApi as useApiForLoader } from '../../api/client.ts';
import { useUpstreamOptionsStore as useUpstreamOptionsStoreForLoader } from '../../composables/useUpstreamOptions.ts';
import type { WireUser } from '../../components/users/types.ts';

export const useUsersPageData = defineBasicLoader(async () => {
  const api = useApiForLoader();
  const [usersRes] = await Promise.all([
    callApiForLoader<WireUser[]>(() => api.api.users.$get()),
    useUpstreamOptionsStoreForLoader().load(),
  ]);
  return { users: usersRes.data ?? [], error: usersRes.error?.message ?? null };
});
</script>

<script setup lang="ts">
import { Button } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import PasswordDrawer from '../../components/users/PasswordDrawer.vue';
import UserDialog from '../../components/users/UserDialog.vue';
import UsersTable from '../../components/users/UsersTable.vue';
import { useUpstreamOptionsStore } from '../../composables/useUpstreamOptions.ts';
import { useAuthStore } from '../../stores/auth.ts';

definePage({ meta: { requiresAdmin: true } });

const api = useApi();
const auth = useAuthStore();
const initial = useUsersPageData();
const upstreamOptionsStore = useUpstreamOptionsStore();

// Route is admin-guarded, so currentUser is always set when this page renders.
const actorUserId = computed(() => {
  if (!auth.currentUser) throw new Error('users page rendered without an authenticated admin');
  return auth.currentUser.id;
});

const users = ref<WireUser[]>(initial.data.value.users);
const error = ref<string | null>(initial.data.value.error);
const upstreamOptions = computed(() => upstreamOptionsStore.options.value ?? []);

const userDialogOpen = ref(false);
const userDialogMode = ref<'create' | 'edit'>('create');
const editTarget = ref<WireUser | null>(null);

const passwordOpen = ref(false);
const passwordTarget = ref<WireUser | null>(null);

const reload = async () => {
  const { data, error: err } = await callApi<WireUser[]>(() => api.api.users.$get());
  if (err) { error.value = err.message; return; }
  users.value = data ?? [];
  error.value = null;
};

const openCreate = () => {
  userDialogMode.value = 'create';
  editTarget.value = null;
  userDialogOpen.value = true;
};

const editUser = (u: WireUser) => {
  userDialogMode.value = 'edit';
  editTarget.value = u;
  userDialogOpen.value = true;
};

const onCreated = (user: WireUser) => {
  void reload();
  if (!users.value.find(u => u.id === user.id)) users.value = [...users.value, user];
};

const resetPassword = (u: WireUser) => {
  passwordTarget.value = u;
  passwordOpen.value = true;
};

const remove = async (u: WireUser) => {
  if (!window.confirm(`Delete user "${u.username}"? Their API keys are soft-deleted and their sessions are revoked.`)) return;
  const { error: err } = await callApi(
    () => api.api.users[':id'].$delete({ param: { id: String(u.id) } }),
  );
  if (err) { window.alert(err.message); return; }
  await reload();
};
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Users</span>
        <Button class="whitespace-nowrap" @click="openCreate">+ New user</Button>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ error }}
      </div>

      <UsersTable
        :users="users"
        :actor-user-id="actorUserId"
        @edit="editUser"
        @reset-password="resetPassword"
        @remove="remove"
      />
    </div>

    <UserDialog
      v-model:open="userDialogOpen"
      :mode="userDialogMode"
      :user="editTarget ?? undefined"
      :actor-user-id="actorUserId"
      :upstreams="upstreamOptions"
      @created="onCreated"
      @saved="reload"
    />
    <PasswordDrawer
      v-model:open="passwordOpen"
      mode="admin"
      :target-user-id="passwordTarget?.id"
      :target-username="passwordTarget?.username"
      @saved="reload"
    />
  </div>
</template>
