<script setup lang="ts">
// Ollama provider-specific fields: just a base URL (default ollama.com) and
// an optional bearer token. The catalog is always live-fetched from
// /api/tags + /api/show — no toggle, no path overrides, no auth-style
// choice. The model-overrides list lives in a separate panel.

import type { OllamaDraft } from './customConfig.ts';
import SecretInput from '../shared/SecretInput.vue';
import { Input } from '@floway-dev/ui';

const draft = defineModel<OllamaDraft>({ required: true });

defineProps<{
  apiKeySet: boolean;
  editMode: boolean;
}>();
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
        <Input
          :model-value="draft.baseUrl"
          placeholder="https://ollama.com"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, baseUrl: v }"
        />
        <p class="mt-1.5 text-[11px] text-gray-600">
          Defaults to <code class="font-mono">https://ollama.com</code>. Point at a self-hosted Ollama daemon (e.g. <code class="font-mono">http://127.0.0.1:11434</code>) to use local models.
        </p>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">
          API Key<span v-if="editMode && apiKeySet" class="text-gray-500"> (leave blank to keep)</span>
        </label>
        <SecretInput
          :model-value="draft.apiKey"
          :placeholder="apiKeySet ? '••••••••' : 'ollama_xxxxx (optional)'"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, apiKey: v }"
        />
        <p class="mt-1.5 text-[11px] text-gray-600">
          Required for <code class="font-mono">ollama.com</code>; optional for an unauthenticated local daemon. Sent as <code class="font-mono">Authorization: Bearer &lt;key&gt;</code> when set.
        </p>
      </div>
    </div>
  </div>
</template>
