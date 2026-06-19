<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ClaudeCodeImportTab, ClaudeCodePkceStartResult } from './claude-code-import-types.ts';
import ClaudeCodeAccountCard from './ClaudeCodeAccountCard.vue';
import ClaudeCodeImportTabs from './ClaudeCodeImportTabs.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { UpstreamRecord } from '../../api/types.ts';
import { Button, Spinner } from '@floway-dev/ui';

type ClaudeCodeUpstreamRecord = Extract<UpstreamRecord, { provider: 'claude-code' }>;

const props = defineProps<{
  mode: 'create' | 'edit';
  record: ClaudeCodeUpstreamRecord | null;
  // Operator's current edit-form proxy_fallback_list. Forwarded into refresh-now
  // so a refresh fired before saving uses the in-progress chain rather than
  // the persisted one.
  proxyFallbackList: string[];
}>();

const emit = defineEmits<{
  imported: [record: UpstreamRecord];
  error: [message: string];
}>();

const api = useApi();

const draft = ref<{ activeTab: ClaudeCodeImportTab; credentialsJsonText: string; callbackUrlText: string }>(
  { activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '' },
);
const submitting = ref(false);
const refreshing = ref(false);
const reimportOpen = ref(false);

const pkce = ref<ClaudeCodePkceStartResult | null>(null);
const pkceLoading = ref(false);
const pkceError = ref<string | null>(null);

const fetchPkceStart = async () => {
  if (pkce.value || pkceLoading.value) return;
  pkceLoading.value = true;
  pkceError.value = null;
  const { data, error } = await callApi<ClaudeCodePkceStartResult>(
    () => api.api.upstreams['claude-code-pkce-start'].$post({ json: {} }),
  );
  pkceLoading.value = false;
  if (error) { pkceError.value = error.message; return; }
  pkce.value = data;
};

const importFormVisible = computed(() => props.mode === 'create' || reimportOpen.value);

watch([importFormVisible, () => draft.value.activeTab], ([visible, tab]) => {
  if (visible && tab === 'callback') void fetchPkceStart();
}, { immediate: true });

const buildBody = (): { ok: true; value: { credentials_json?: string; callback?: { callback_url: string } } } | { ok: false; error: string } => {
  if (draft.value.activeTab === 'credentials_json') {
    const text = draft.value.credentialsJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.claude/.credentials.json' };
    // The handler runs JSON.parse server-side and reports a parse error. We
    // still try-parse here so the operator gets immediate feedback rather
    // than a round-trip on a typo.
    try { JSON.parse(text); } catch (e) { return { ok: false, error: `credentials.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { credentials_json: text } };
  }
  const url = draft.value.callbackUrlText.trim();
  if (!url) return { ok: false, error: 'Paste the URL the browser was redirected to' };
  return { ok: true, value: { callback: { callback_url: url } } };
};

const submit = async () => {
  const body = buildBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  let result;
  if (props.mode === 'create') {
    result = await callApi<UpstreamRecord>(() => api.api.upstreams['claude-code-import'].$post({ json: body.value }));
  } else {
    // The re-import button is rendered only when `record` is bound; the
    // template guard upstream guarantees non-null here.
    if (!props.record) throw new Error('Re-import requires a saved record');
    const id = props.record.id;
    result = await callApi<UpstreamRecord>(() => api.api.upstreams[':id']['claude-code-reimport'].$post({ param: { id }, json: body.value }));
  }
  submitting.value = false;
  if (result.error) { emit('error', result.error.message); return; }
  emit('imported', result.data);
  draft.value = { activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '' };
  pkce.value = null;
  reimportOpen.value = false;
};

const refreshTokenNow = async () => {
  if (!props.record) throw new Error('refreshTokenNow requires a saved record');
  const id = props.record.id;
  refreshing.value = true;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id']['claude-code-refresh-now'].$post({
      param: { id },
      json: { proxy_fallback_list: props.proxyFallbackList },
    }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  emit('imported', data);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="mode === 'edit' && record">
      <ClaudeCodeAccountCard :record="record" />
      <div class="flex flex-wrap items-center gap-2">
        <Button :loading="refreshing" @click="refreshTokenNow">
          <Spinner v-if="refreshing" class="size-3.5" />
          <i v-else class="i-lucide-refresh-cw size-3.5" />
          Refresh token now
        </Button>
        <Button variant="secondary" @click="reimportOpen = !reimportOpen">
          <i class="i-lucide-key-round size-3.5" />
          {{ reimportOpen ? 'Cancel re-import' : 'Re-import credential' }}
        </Button>
      </div>
    </template>

    <template v-if="importFormVisible">
      <p v-if="mode === 'create'" class="text-xs text-gray-500">
        Claude Code credentials come from the official Claude desktop / CLI. Either sign in through the
        OAuth browser flow below, or paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.claude/.credentials.json</code>
        from a logged-in workstation.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <ClaudeCodeImportTabs
        v-model:active-tab="draft.activeTab"
        v-model:credentials-json-text="draft.credentialsJsonText"
        v-model:callback-url-text="draft.callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
        :pkce-error="pkceError"
      />
      <div class="flex justify-end">
        <Button :loading="submitting" @click="submit">
          <Spinner v-if="submitting" class="size-3.5" />
          {{ mode === 'create' ? 'Import' : 'Re-import' }}
        </Button>
      </div>
    </template>
  </div>
</template>
