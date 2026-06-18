<script setup lang="ts">
// Presentation-only paste area for the Claude Code OAuth + credentials.json
// import flow. The parent owns the PKCE state and submission.

import type { ClaudeCodeImportTab, ClaudeCodePkceStartResult } from './claude-code-import-types.ts';
import { Button, Spinner, Tabs, Textarea } from '@floway-dev/ui';

const props = defineProps<{
  pkce: ClaudeCodePkceStartResult | null;
  pkceLoading: boolean;
  pkceError: string | null;
}>();

const activeTab = defineModel<ClaudeCodeImportTab>('activeTab', { required: true });
const credentialsJsonText = defineModel<string>('credentialsJsonText', { required: true });
const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });

const importTabs = [
  { value: 'callback', label: 'Sign in with Claude' },
  { value: 'credentials_json', label: 'Paste credentials.json' },
] as const;

const copyAuthorizeUrl = async () => {
  if (!props.pkce) return;
  try { await navigator.clipboard.writeText(props.pkce.authorize_url); } catch { /* clipboard is best-effort; the visible link still works */ }
};
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
            <Button size="sm" variant="secondary" @click="copyAuthorizeUrl">
              <i class="i-lucide-clipboard size-3.5" /> Copy URL
            </Button>
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
