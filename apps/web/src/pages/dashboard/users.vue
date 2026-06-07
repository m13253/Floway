<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi as callApiForLoader, useApi as useApiForLoader } from '../../api/client.ts';

interface WireUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
  deletedAt: string | null;
}

export const useUsersPageData = defineBasicLoader(async () => {
  const api = useApiForLoader();
  const { data, error } = await callApiForLoader<WireUser[]>(() => api.api.users.$get());
  return { users: data ?? [], error: error?.message ?? null };
});
</script>

<script setup lang="ts">
import { Button, Code } from '@floway-dev/ui';
import { ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import PasswordDrawer from '../../components/users/PasswordDrawer.vue';
import UserDrawer from '../../components/users/UserDrawer.vue';
import UsersTable from '../../components/users/UsersTable.vue';
import { useAuthStore } from '../../stores/auth.ts';

definePage({ meta: { requiresAdmin: true } });

const api = useApi();
const auth = useAuthStore();
const initial = useUsersPageData();

const users = ref<WireUser[]>(initial.data.value.users);
const error = ref<string | null>(initial.data.value.error);

const createOpen = ref(false);
const passwordOpen = ref(false);
const passwordTarget = ref<WireUser | null>(null);

const revealedKey = ref<{ name: string; key: string } | null>(null);

const reload = async () => {
  const { data, error: err } = await callApi<WireUser[]>(() => api.api.users.$get());
  if (err) { error.value = err.message; return; }
  users.value = data ?? [];
  error.value = null;
};

const onCreated = ({ user, defaultKey }: { user: WireUser; defaultKey: { name: string; key: string } }) => {
  revealedKey.value = defaultKey;
  void reload();
  // Bring the just-created user into the local list optimistically.
  if (!users.value.find(u => u.id === user.id)) users.value = [...users.value, user];
};

const toggleAdmin = async (u: WireUser) => {
  const { error: err } = await callApi(
    () => api.api.users[':id'].$patch({ param: { id: String(u.id) }, json: { isAdmin: !u.isAdmin } }),
  );
  if (err) { window.alert(err.message); return; }
  await reload();
};

const toggleGlobalTelemetry = async (u: WireUser) => {
  const { error: err } = await callApi(
    () => api.api.users[':id'].$patch({ param: { id: String(u.id) }, json: { canViewGlobalTelemetry: !u.canViewGlobalTelemetry } }),
  );
  if (err) { window.alert(err.message); return; }
  await reload();
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

const dismissRevealed = () => { revealedKey.value = null; };
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Users</span>
        <Button class="whitespace-nowrap" @click="createOpen = true">+ New user</Button>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ error }}
      </div>

      <div v-if="revealedKey" class="mb-4 rounded-md border border-accent-emerald/40 bg-accent-emerald/10 px-3 py-3 text-sm text-accent-emerald">
        <p class="mb-2">
          <strong class="text-white">{{ revealedKey.name }}</strong> created. Copy this key now —
          it will not be shown again.
        </p>
        <div class="flex items-center gap-2">
          <Code :code="revealedKey.key" copyable class="flex-1 break-all" />
          <Button variant="secondary" size="sm" @click="dismissRevealed">Dismiss</Button>
        </div>
      </div>

      <UsersTable
        :users="users"
        :actor-user-id="auth.currentUser?.id ?? -1"
        @toggle-admin="toggleAdmin"
        @toggle-global-telemetry="toggleGlobalTelemetry"
        @reset-password="resetPassword"
        @remove="remove"
      />
    </div>

    <UserDrawer v-model:open="createOpen" @created="onCreated" />
    <PasswordDrawer
      v-model:open="passwordOpen"
      mode="admin"
      :target-user-id="passwordTarget?.id"
      :target-username="passwordTarget?.username"
      @saved="reload"
    />
  </div>
</template>
