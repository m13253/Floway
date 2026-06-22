<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ClaudeCodeAuthorizeUrlResult, ClaudeCodeImportTab } from './claude-code-import-types.ts';
import ClaudeCodeAccountCard from './ClaudeCodeAccountCard.vue';
import ClaudeCodeImportTabs from './ClaudeCodeImportTabs.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ProxyFallbackEntry, UpstreamRecord } from '../../api/types.ts';
import { generatePkce, parseCallbackPaste, pkceStorageKey, recallPkce, stashPkce } from '../../lib/pkce.ts';
import { Button, Spinner } from '@floway-dev/ui';

type ClaudeCodeUpstreamRecord = Extract<UpstreamRecord, { provider: 'claude-code' }>;

const props = defineProps<{
  mode: 'create' | 'edit';
  record: ClaudeCodeUpstreamRecord | null;
  // Operator's current edit-form proxy_fallback_list. Forwarded into
  // import / re-import (so the OAuth bootstrap routes through the chain
  // the operator is editing AND the chain is persisted on the new row)
  // and into refresh-now (so a refresh fired before saving uses the
  // in-progress chain rather than the persisted one).
  proxyFallbackList: ProxyFallbackEntry[];
}>();

const emit = defineEmits<{
  imported: [record: UpstreamRecord];
  // Quota refresh updates a single in-place slot (`usageProbeSnapshot`) on
  // the existing record. A distinct event from `imported` because the
  // parent's `imported` handler navigates / re-keys the loader, which is
  // the wrong response for a non-mutating data refresh.
  'quota-refreshed': [record: UpstreamRecord];
  error: [message: string];
}>();

const api = useApi();
// Both flows share one sessionStorage slot per provider; the random `state`
// echoed back from the consent screen disambiguates oauth from setup-token
// on its own because each `prepareAuthorize` call mints fresh state.
const storageKey = pkceStorageKey('claude-code');

const draft = ref<{
  activeTab: ClaudeCodeImportTab;
  credentialsJsonText: string;
  callbackUrlText: string;
  setupTokenCallbackUrlText: string;
}>(
  { activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '', setupTokenCallbackUrlText: '' },
);
const submitting = ref(false);
const refreshing = ref(false);
const probing = ref(false);
const reimportOpen = ref(false);

const pkce = ref<ClaudeCodeAuthorizeUrlResult | null>(null);
const pkceLoading = ref(false);
const pkceError = ref<string | null>(null);

const setupTokenPkce = ref<ClaudeCodeAuthorizeUrlResult | null>(null);
const setupTokenPkceLoading = ref(false);
const setupTokenPkceError = ref<string | null>(null);

// The verifier + state are minted in-browser, stashed in sessionStorage, and
// the server is asked only to stamp the matching challenge + state into its
// authorize URL. The verifier never leaves the browser until the matching
// callback comes back as `{code, verifier}` on import.
const prepareAuthorize = async (kind: 'oauth' | 'setup-token') => {
  const target = kind === 'oauth' ? pkce : setupTokenPkce;
  const loadingFlag = kind === 'oauth' ? pkceLoading : setupTokenPkceLoading;
  const errorFlag = kind === 'oauth' ? pkceError : setupTokenPkceError;
  if (target.value || loadingFlag.value) return;
  loadingFlag.value = true;
  errorFlag.value = null;
  const { verifier, challenge, state } = await generatePkce();
  stashPkce(storageKey, { verifier, state });
  const { data, error } = await callApi<ClaudeCodeAuthorizeUrlResult>(
    () => api.api.upstreams['claude-code-authorize-url'].$post({ json: { challenge, state, kind } }),
  );
  loadingFlag.value = false;
  if (error) { errorFlag.value = error.message; return; }
  target.value = data;
};

const importFormVisible = computed(() => props.mode === 'create' || reimportOpen.value);

// Each authorize URL bakes Anthropic's scope server-side, so we cannot share
// a single in-flight session between tabs. The shared sessionStorage slot is
// safe because every `prepareAuthorize` call mints fresh state — the most
// recently prepared flow wins the recall when its callback comes back.
watch([importFormVisible, () => draft.value.activeTab], ([visible, tab]) => {
  if (!visible) return;
  if (tab === 'callback') void prepareAuthorize('oauth');
  else if (tab === 'setup_token_callback') void prepareAuthorize('setup-token');
}, { immediate: true });

type CallbackCredential = { code: string; verifier: string };

type SubmitPayload =
  | { kind: 'oauth-credentials_json'; credentials_json: string }
  | { kind: 'oauth-callback'; callback: CallbackCredential }
  | { kind: 'setup-token-callback'; callback: CallbackCredential };

const buildCallbackCredential = (pasteText: string): { ok: true; value: CallbackCredential } | { ok: false; error: string } => {
  const text = pasteText.trim();
  if (!text) return { ok: false, error: 'Paste the URL the browser was redirected to' };
  let parsed: { code: string; state: string };
  try { parsed = parseCallbackPaste(text); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const recalled = recallPkce(storageKey, parsed.state);
  if (!recalled) return { ok: false, error: 'Authorization flow not recognized; restart the flow' };
  return { ok: true, value: { code: parsed.code, verifier: recalled.verifier } };
};

const buildBody = (): { ok: true; value: SubmitPayload } | { ok: false; error: string } => {
  if (draft.value.activeTab === 'credentials_json') {
    const text = draft.value.credentialsJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.claude/.credentials.json' };
    // The handler runs JSON.parse server-side and reports a parse error. We
    // still try-parse here so the operator gets immediate feedback rather
    // than a round-trip on a typo.
    try { JSON.parse(text); } catch (e) { return { ok: false, error: `credentials.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { kind: 'oauth-credentials_json', credentials_json: text } };
  }
  if (draft.value.activeTab === 'setup_token_callback') {
    const credential = buildCallbackCredential(draft.value.setupTokenCallbackUrlText);
    if (!credential.ok) return credential;
    return { ok: true, value: { kind: 'setup-token-callback', callback: credential.value } };
  }
  const credential = buildCallbackCredential(draft.value.callbackUrlText);
  if (!credential.ok) return credential;
  return { ok: true, value: { kind: 'oauth-callback', callback: credential.value } };
};

const submit = async () => {
  if (submitting.value) return;
  const body = buildBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  // Thread the in-flight proxy chain into the bootstrap (so OAuth /
  // identity calls route through it) and into persistence (so the new /
  // updated row carries the same chain).
  const proxyExtras = { proxy_fallback_list: props.proxyFallbackList };
  let result;
  if (props.mode === 'create') {
    if (body.value.kind === 'setup-token-callback') {
      const payload = { callback: body.value.callback, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams['claude-code-setup-token-import'].$post({ json: payload }));
    } else if (body.value.kind === 'oauth-credentials_json') {
      const payload = { credentials_json: body.value.credentials_json, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams['claude-code-import'].$post({ json: payload }));
    } else {
      const payload = { callback: body.value.callback, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams['claude-code-import'].$post({ json: payload }));
    }
  } else {
    // The re-import affordance is rendered only when `record` is bound; if the
    // ref is somehow empty by the time the click lands, bail rather than fire
    // a doomed request.
    if (!props.record) { submitting.value = false; return; }
    const id = props.record.id;
    if (body.value.kind === 'setup-token-callback') {
      const payload = { callback: body.value.callback, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams[':id']['claude-code-setup-token-reimport'].$post({ param: { id }, json: payload }));
    } else if (body.value.kind === 'oauth-credentials_json') {
      const payload = { credentials_json: body.value.credentials_json, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams[':id']['claude-code-reimport'].$post({ param: { id }, json: payload }));
    } else {
      const payload = { callback: body.value.callback, ...proxyExtras };
      result = await callApi<UpstreamRecord>(() => api.api.upstreams[':id']['claude-code-reimport'].$post({ param: { id }, json: payload }));
    }
  }
  submitting.value = false;
  if (result.error) { emit('error', result.error.message); return; }
  emit('imported', result.data);
  draft.value = { activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '', setupTokenCallbackUrlText: '' };
  pkce.value = null;
  setupTokenPkce.value = null;
  reimportOpen.value = false;
};

// Refresh-now is only meaningful for OAuth credentials (setup-token has
// no rotation counterpart). The button is hidden for setup-token rows AND
// for empty-account rows so the operator never sees a doomed affordance.
const refreshable = computed(() => {
  const account = props.record?.state?.accounts[0];
  return account?.tokenKind === 'oauth';
});

const refreshTokenNow = async () => {
  if (refreshing.value) return;
  if (!props.record) return;
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
  // Refresh is a non-mutating data update — the row's credential identity is
  // unchanged, only the access-token slot rotates. Surface through the same
  // event as quota refresh so the parent lands the new record on `liveRecord`
  // without re-keying the loader or navigating.
  emit('quota-refreshed', data);
};

// The probe-quota route returns the live `/api/oauth/usage` body spread at
// the top level alongside a gateway-stamped `fetched_at`. The gateway also
// persists into `state.accounts[0].usageProbeSnapshot`, but we don't have a
// per-record GET endpoint to re-read — and re-running the upstreams list
// for a single non-mutating snapshot would be wasteful. Mirror the persisted
// shape locally from the response so the card re-renders against the same
// data the next list-load would yield.
interface ProbeResponse {
  fetched_at: string;
  // Anthropic adds fields without warning; we round-trip the rest of the
  // body into the dashboard's `data: unknown` slot exactly as the gateway
  // persists it.
  [k: string]: unknown;
}

const refreshQuotaNow = async () => {
  if (probing.value) return;
  if (!props.record) return;
  const record = props.record;
  // The gateway route mints an access token via ensureClaudeCodeAccessToken,
  // which throws when state has no account credentials. Refuse here so the
  // UI doesn't fire a doomed request when the button surface bypasses the
  // AccountCard's missing-state warning.
  if (!record.state || record.state.accounts.length === 0) {
    emit('error', 'Quota probe requires a Claude Code credential — re-import to populate state.');
    return;
  }
  probing.value = true;
  const { data, error } = await callApi<ProbeResponse>(
    () => api.api.upstreams[':id']['probe-quota'].$post({
      param: { id: record.id },
      json: { proxy_fallback_list: props.proxyFallbackList },
    }),
  );
  probing.value = false;
  if (error) { emit('error', error.message); return; }

  const { fetched_at: fetchedAtIso, ...body } = data;
  const fetchedAtMs = Date.parse(fetchedAtIso);
  const nextAccounts = record.state.accounts.map((acc, idx) => idx === 0 ? { ...acc, usageProbeSnapshot: { fetchedAt: fetchedAtMs, data: body } } : acc);
  const next: UpstreamRecord = { ...record, state: { ...record.state, accounts: nextAccounts } };
  emit('quota-refreshed', next);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="mode === 'edit' && record">
      <ClaudeCodeAccountCard :record="record" :probing="probing" @refresh-quota="refreshQuotaNow" />
      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="refreshable" :loading="refreshing" @click="refreshTokenNow">
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
        Claude Code credentials come from the official Claude desktop / CLI. Sign in through the OAuth browser
        flow below, paste a long-lived Setup Token (inference-only, safer for shared deployments), or paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.claude/.credentials.json</code>
        from a logged-in workstation.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <ClaudeCodeImportTabs
        v-model:active-tab="draft.activeTab"
        v-model:credentials-json-text="draft.credentialsJsonText"
        v-model:callback-url-text="draft.callbackUrlText"
        v-model:setup-token-callback-url-text="draft.setupTokenCallbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
        :pkce-error="pkceError"
        :setup-token-pkce="setupTokenPkce"
        :setup-token-pkce-loading="setupTokenPkceLoading"
        :setup-token-pkce-error="setupTokenPkceError"
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
