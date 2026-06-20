<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

import type { ClaudeCodeImportTab, ClaudeCodePkceStartResult } from './claude-code-import-types.ts';
import { Button, Spinner, Tabs, Textarea } from '@floway-dev/ui';

// `pkce` and `setupTokenPkce` carry independent in-flight PKCE sessions
// because each authorize URL bakes a different `scope` at Anthropic, and
// the operator may open one tab without ever visiting the other. The
// parent fetches each lazily when its tab is selected.
defineProps<{
  pkce: ClaudeCodePkceStartResult | null;
  pkceLoading: boolean;
  pkceError: string | null;
  setupTokenPkce: ClaudeCodePkceStartResult | null;
  setupTokenPkceLoading: boolean;
  setupTokenPkceError: string | null;
}>();

const activeTab = defineModel<ClaudeCodeImportTab>('activeTab', { required: true });
const credentialsJsonText = defineModel<string>('credentialsJsonText', { required: true });
const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });
const setupTokenCallbackUrlText = defineModel<string>('setupTokenCallbackUrlText', { required: true });

const importTabs = [
  { value: 'callback', label: 'Sign in with Claude' },
  { value: 'setup_token_callback', label: 'Setup Token' },
  { value: 'credentials_json', label: 'Paste credentials.json' },
] as const;

// 'copied' shows a tick for 2s on success; 'failed' surfaces the underlying
// clipboard error inline so the operator can fall back to selecting the
// visible link manually. One status per copyable URL so two near-simultaneous
// copies don't overwrite each other's feedback.
type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'failed'; message: string };
const oauthCopyStatus = ref<CopyState>({ kind: 'idle' });
const setupTokenCopyStatus = ref<CopyState>({ kind: 'idle' });
let oauthCopyResetTimer: ReturnType<typeof setTimeout> | undefined;
let setupTokenCopyResetTimer: ReturnType<typeof setTimeout> | undefined;

const copyUrl = async (url: string, target: 'oauth' | 'setup-token') => {
  const status = target === 'oauth' ? oauthCopyStatus : setupTokenCopyStatus;
  if (target === 'oauth' && oauthCopyResetTimer !== undefined) clearTimeout(oauthCopyResetTimer);
  if (target === 'setup-token' && setupTokenCopyResetTimer !== undefined) clearTimeout(setupTokenCopyResetTimer);
  try {
    await navigator.clipboard.writeText(url);
    status.value = { kind: 'copied' };
    const timer = setTimeout(() => { status.value = { kind: 'idle' }; }, 2000);
    if (target === 'oauth') oauthCopyResetTimer = timer;
    else setupTokenCopyResetTimer = timer;
  } catch (e) {
    status.value = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
};

// Clearing the in-flight reset timers on unmount avoids a late `idle` write
// to an already-discarded ref when the parent tears the panel down between a
// copy and its 2s reset.
onBeforeUnmount(() => {
  if (oauthCopyResetTimer !== undefined) clearTimeout(oauthCopyResetTimer);
  if (setupTokenCopyResetTimer !== undefined) clearTimeout(setupTokenCopyResetTimer);
});
</script>

<template>
  <Tabs v-model="activeTab" :tabs="[...importTabs]">
    <template #callback>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Open the authorize URL in a browser signed in to your Claude account, complete the consent screen,
          then paste the URL the browser was redirected to (it starts with
          <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">https://platform.claude.com/oauth/code/callback</code>).
          Pasting just the <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">?code=&hellip;&amp;state=&hellip;</code> fragment is also accepted.
        </p>

        <div v-if="pkceLoading" class="flex items-center gap-2 text-sm text-gray-400">
          <Spinner class="size-4" /> Preparing PKCE flow&hellip;
        </div>

        <div v-else-if="pkce" class="space-y-2">
          <p class="text-xs font-medium text-gray-500">Authorize URL</p>
          <a :href="pkce.authorize_url" target="_blank" rel="noopener" class="block break-all text-xs text-accent-cyan hover:underline">
            {{ pkce.authorize_url }}
          </a>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <Button size="sm" variant="secondary" @click="copyUrl(pkce.authorize_url, 'oauth')">
              <i class="i-lucide-clipboard size-3.5" /> Copy URL
            </Button>
            <span v-if="oauthCopyStatus.kind === 'copied'" class="text-accent-emerald">Copied</span>
            <span v-else-if="oauthCopyStatus.kind === 'failed'" class="text-accent-rose">Copy failed: {{ oauthCopyStatus.message }}</span>
            <span>Expires in {{ Math.round(pkce.expires_in_seconds / 60) }} min</span>
          </div>
        </div>

        <p v-if="pkceError" class="text-xs text-accent-rose">{{ pkceError }}</p>

        <Textarea
          v-model="callbackUrlText"
          :rows="3"
          monospace
          placeholder="https://platform.claude.com/oauth/code/callback?code=...&state=..."
        />
      </div>
    </template>

    <template #setup_token_callback>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          The Setup Token is a long-lived (~1 year) credential scoped to inference only — it cannot create or
          rotate API keys, and the gateway cannot refresh it. When the token eventually expires you re-import
          a fresh one through this same flow. Preferable to the full OAuth flow for shared deployments where
          the gateway should not hold a credential that can self-mint API keys.
        </p>

        <div v-if="setupTokenPkceLoading" class="flex items-center gap-2 text-sm text-gray-400">
          <Spinner class="size-4" /> Preparing PKCE flow&hellip;
        </div>

        <div v-else-if="setupTokenPkce" class="space-y-2">
          <p class="text-xs font-medium text-gray-500">Authorize URL</p>
          <a :href="setupTokenPkce.authorize_url" target="_blank" rel="noopener" class="block break-all text-xs text-accent-cyan hover:underline">
            {{ setupTokenPkce.authorize_url }}
          </a>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <Button size="sm" variant="secondary" @click="copyUrl(setupTokenPkce.authorize_url, 'setup-token')">
              <i class="i-lucide-clipboard size-3.5" /> Copy URL
            </Button>
            <span v-if="setupTokenCopyStatus.kind === 'copied'" class="text-accent-emerald">Copied</span>
            <span v-else-if="setupTokenCopyStatus.kind === 'failed'" class="text-accent-rose">Copy failed: {{ setupTokenCopyStatus.message }}</span>
            <span>Expires in {{ Math.round(setupTokenPkce.expires_in_seconds / 60) }} min</span>
          </div>
        </div>

        <p v-if="setupTokenPkceError" class="text-xs text-accent-rose">{{ setupTokenPkceError }}</p>

        <Textarea
          v-model="setupTokenCallbackUrlText"
          :rows="3"
          monospace
          placeholder="https://platform.claude.com/oauth/code/callback?code=...&state=..."
        />
      </div>
    </template>

    <template #credentials_json>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Paste the contents of <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.claude/.credentials.json</code>
          after signing in with the Claude Code CLI. The gateway keeps only the OAuth refresh token + identity fields.
        </p>
        <div class="flex items-start gap-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
          <i class="i-lucide-triangle-alert mt-0.5 size-4 shrink-0" />
          <span>
            The pasted JSON contains your live OAuth refresh token. Anyone with this file can sign in to your Claude account. Do not share or screenshot.
          </span>
        </div>
        <Textarea
          v-model="credentialsJsonText"
          :rows="10"
          monospace
          placeholder='{"claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1750000000000, "subscriptionType": "max_20x" } }'
        />
      </div>
    </template>
  </Tabs>
</template>
