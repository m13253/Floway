<script setup lang="ts">
import { Button, Dialog, Spinner } from '@floway-dev/ui';
import { ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import SecretInput from '../shared/SecretInput.vue';

// Two-mode password change drawer.
//   - mode="self"   pairs `currentPassword` and `newPassword` and posts to
//                   /api/users/me/password.
//   - mode="admin"  takes only `newPassword` and posts to
//                   /api/users/:id (admin password reset).
const open = defineModel<boolean>('open');

const props = defineProps<{
  mode: 'self' | 'admin';
  // Required only for admin mode.
  targetUserId?: number;
  // Display name of the target — admin-mode title only.
  targetUsername?: string;
}>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref<string | null>(null);
const saving = ref(false);

watch(open, v => {
  if (!v) return;
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  error.value = null;
});

const submit = async () => {
  if (!newPassword.value) {
    error.value = 'New password is required';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }
  saving.value = true;
  error.value = null;
  if (props.mode === 'self') {
    if (!currentPassword.value) {
      error.value = 'Current password is required';
      saving.value = false;
      return;
    }
    const { error: err } = await callApi(
      () => api.api.users.me.password.$patch({ json: { currentPassword: currentPassword.value, newPassword: newPassword.value } }),
    );
    saving.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
  } else {
    if (props.targetUserId === undefined) {
      saving.value = false;
      error.value = 'Missing target user';
      return;
    }
    const { error: err } = await callApi(
      () => api.api.users[':id'].$patch({ param: { id: String(props.targetUserId) }, json: { password: newPassword.value } }),
    );
    saving.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
  }
  open.value = false;
  emit('saved');
};

const title = (() => {
  if (props.mode === 'self') return 'Change my password';
  return props.targetUsername ? `Reset password — ${props.targetUsername}` : 'Reset password';
})();
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="md" :auto-focus-on-open="false">
    <form class="space-y-4" @submit.prevent="submit">
      <div v-if="mode === 'self'" class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Current password</label>
        <SecretInput v-model="currentPassword" />
      </div>
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">New password</label>
        <SecretInput v-model="newPassword" />
      </div>
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Confirm new password</label>
        <SecretInput v-model="confirmPassword" />
      </div>

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <p v-if="mode === 'self'" class="text-xs text-gray-500">
        Other devices currently logged in as you will be signed out.
      </p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" type="button" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" type="submit">
          <Spinner v-if="saving" class="size-3.5" />
          Save
        </Button>
      </footer>
    </form>
  </Dialog>
</template>
