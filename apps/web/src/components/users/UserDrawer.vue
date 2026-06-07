<script setup lang="ts">
import { Button, Dialog, Input, Spinner, Switch } from '@floway-dev/ui';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import SecretInput from '../shared/SecretInput.vue';
import type { WireUser } from './types.ts';

// The create response carries the synthesized default API key in cleartext for one-shot reveal.
const open = defineModel<boolean>('open');

const emit = defineEmits<{ created: [payload: { user: WireUser; defaultKey: { name: string; key: string } }] }>();

const api = useApi();

const username = ref('');
const password = ref('');
const isAdmin = ref(false);
const canViewGlobalTelemetry = ref(false);
const error = ref<string | null>(null);
const saving = ref(false);

watch(open, v => {
  if (!v) return;
  username.value = '';
  password.value = '';
  isAdmin.value = false;
  canViewGlobalTelemetry.value = false;
  error.value = null;
});

const usernameValid = computed(() => /^[a-zA-Z0-9_.\-]{1,64}$/.test(username.value));

const submit = async () => {
  if (!usernameValid.value) {
    error.value = 'Username must match [A-Za-z0-9_.-] (1–64 chars)';
    return;
  }
  if (!password.value) {
    error.value = 'Password is required';
    return;
  }
  saving.value = true;
  error.value = null;
  const { data, error: err } = await callApi<{ user: WireUser; defaultKey: { name: string; key: string } }>(
    () => api.api.users.$post({
      json: {
        username: username.value,
        password: password.value,
        isAdmin: isAdmin.value,
        canViewGlobalTelemetry: canViewGlobalTelemetry.value,
      },
    }),
  );
  saving.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  open.value = false;
  emit('created', data!);
};
</script>

<template>
  <Dialog v-model:open="open" title="New user" size="md" :auto-focus-on-open="false">
    <form class="space-y-4" @submit.prevent="submit">
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Username</label>
        <Input v-model="username" autocomplete="off" :invalid="username !== '' && !usernameValid" />
        <p class="text-[11px] text-gray-500">Letters, digits, dot, dash, underscore. Max 64 chars.</p>
      </div>
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Initial password</label>
        <SecretInput v-model="password" />
      </div>
      <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
        <span>
          <p class="text-sm text-white">Administrator</p>
          <p class="text-xs text-gray-500">Can manage users, upstreams, search config, import/export.</p>
        </span>
        <Switch v-model="isAdmin" />
      </label>
      <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
        <span>
          <p class="text-sm text-white">Global telemetry visibility</p>
          <p class="text-xs text-gray-500">Allow viewing other users' usage and performance.</p>
        </span>
        <Switch v-model="canViewGlobalTelemetry" :disabled="isAdmin" />
      </label>

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" type="button" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" type="submit">
          <Spinner v-if="saving" class="size-3.5" />
          Create user
        </Button>
      </footer>
    </form>
  </Dialog>
</template>
