<!--
  Dev-only mock host for the real ProxyFallbackListPanel. Lets us iterate on
  the editor's visual behaviour without spinning up an upstream + a real
  proxy + sitting in the admin dashboard. Backed by `__setMockProxiesStoreForDev`,
  which directly pokes the same module state the real composable returns.

  Open: http://localhost:5174/mock-fallback
-->
<script setup lang="ts">
import { onBeforeMount, ref } from 'vue';

import type { BackoffRow, ProxyFallbackEntry, ProxyRecord } from '../api/types.ts';
import ProxyFallbackListPanel from '../components/upstream-edit/ProxyFallbackListPanel.vue';
import { __setMockProxiesStoreForDev } from '../composables/useProxies.ts';

definePage({ meta: { public: true } });

const mockProxies: ProxyRecord[] = [
  { id: 'p-jp-tokyo', name: 'jp-tokyo-trojan', url: 'trojan://example', dial_timeout_seconds: null, created_at: '', updated_at: '' },
  { id: 'p-us-west', name: 'us-west-vless', url: 'vless://example', dial_timeout_seconds: null, created_at: '', updated_at: '' },
  { id: 'p-eu-ams', name: 'eu-amsterdam-ss', url: 'ss://example', dial_timeout_seconds: null, created_at: '', updated_at: '' },
  { id: 'p-sg-sin', name: 'sg-singapore-reality', url: 'reality://example', dial_timeout_seconds: null, created_at: '', updated_at: '' },
  { id: 'p-long', name: 'very-long-proxy-name-that-might-overflow-the-row-test', url: 'http://example', dial_timeout_seconds: null, created_at: '', updated_at: '' },
];

const initialList: ProxyFallbackEntry[] = [
  { id: 'p-jp-tokyo', colos: ['NRT', 'KIX'] },
  { id: 'p-eu-ams' },
  { id: 'direct', colos: ['NRT', 'LAX', 'AMS'] },
  { id: 'p-us-west', colos: ['LAX', 'SJC'] },
  { id: 'p-long' },
  { id: 'orphan-deleted-uuid', colos: ['HKG'] },
];

const list = ref<ProxyFallbackEntry[]>([...initialList]);

// In production this comes from useRuntimeInfo (fetched once at dashboard
// load). The mock fakes it so we can switch kinds + colos and observe the
// editor's UX degrade between cloudflare and node.
type Kind = 'cloudflare' | 'node';
const runtimeKind = ref<Kind>('cloudflare');
const currentColo = ref<string>('HKG');

const coloAware = ref<boolean>(true);
const updateColoAware = (): void => { coloAware.value = runtimeKind.value === 'cloudflare'; };

const backoffsSeed: BackoffRow[] = [
  { proxy_id: 'p-jp-tokyo', upstream_id: 'mock-upstream', fail_count: 3, expires_at: Math.floor(Date.now() / 1000) + 47, last_error: 'connect ETIMEDOUT 192.168.1.1:443', last_error_at: Math.floor(Date.now() / 1000) - 5 },
];
const backoffs = ref<BackoffRow[]>([...backoffsSeed]);

const refreshStore = (): void => {
  __setMockProxiesStoreForDev({ proxies: mockProxies, backoffs: backoffs.value });
};

onBeforeMount(refreshStore);

const resetList = (): void => { list.value = [...initialList]; };
const toggleBackoff = (proxyId: string): void => {
  const idx = backoffs.value.findIndex(b => b.proxy_id === proxyId);
  if (idx >= 0) backoffs.value = backoffs.value.filter((_, i) => i !== idx);
  else backoffs.value = [...backoffs.value, { proxy_id: proxyId, upstream_id: 'mock-upstream', fail_count: 2, expires_at: Math.floor(Date.now() / 1000) + 30, last_error: 'connect ECONNREFUSED 10.0.0.5:8388', last_error_at: Math.floor(Date.now() / 1000) - 1 }];
  refreshStore();
};
</script>

<template>
  <div class="min-h-screen bg-surface-900 py-10">
    <div class="mx-auto max-w-2xl space-y-6 px-4">

      <section class="rounded-2xl border border-white/[0.08] bg-surface-800/60 p-4">
        <p class="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Mock controls <span class="text-accent-violet">(dev-only)</span>
        </p>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-gray-500">Runtime kind:</span>
          <div class="flex gap-1">
            <button
              v-for="k in (['cloudflare', 'node'] as Kind[])"
              :key="k"
              type="button"
              class="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors"
              :class="runtimeKind === k
                ? 'border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan'
                : 'border-white/[0.08] bg-surface-700 text-gray-400 hover:border-white/[0.16] hover:text-white'"
              @click="runtimeKind = k; updateColoAware()"
            >{{ k }}</button>
          </div>
          <span class="ml-3 text-gray-500">Current colo:</span>
          <div class="flex gap-1">
            <button
              v-for="c in ['', 'HKG', 'NRT', 'LAX', 'AMS']"
              :key="c || 'none'"
              type="button"
              class="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors"
              :class="currentColo === c
                ? 'border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan'
                : 'border-white/[0.08] bg-surface-700 text-gray-400 hover:border-white/[0.16] hover:text-white'"
              @click="currentColo = c"
            >{{ c || 'none' }}</button>
          </div>
          <span class="ml-3 text-gray-500">Toggle backoff:</span>
          <button
            v-for="p in mockProxies.slice(0, 3)"
            :key="p.id"
            type="button"
            class="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors"
            :class="backoffs.some(b => b.proxy_id === p.id)
              ? 'border-accent-amber/40 bg-accent-amber/10 text-accent-amber'
              : 'border-white/[0.08] bg-surface-700 text-gray-400 hover:border-white/[0.16] hover:text-white'"
            @click="toggleBackoff(p.id)"
          >{{ p.name }}</button>
          <button
            type="button"
            class="ml-auto rounded-md border border-white/[0.08] bg-surface-700 px-2 py-0.5 text-[11px] text-gray-400 transition-colors hover:border-white/[0.16] hover:text-white"
            @click="resetList"
          >Reset list</button>
        </div>
      </section>

      <section class="rounded-2xl border border-white/[0.06] bg-surface-800/40 p-4">
        <ProxyFallbackListPanel
          v-model="list"
          upstream-id="mock-upstream"
          :colo-aware="coloAware"
          :current-colo="currentColo || null"
        />
      </section>
    </div>
  </div>
</template>
