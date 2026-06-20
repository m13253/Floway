<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';

import { collectByKind, detectCollectKind, type CollectOutcome } from './collect.ts';
import { authFetch } from '../../api/client.ts';
import type { DumpRecord, DumpStreamEvent } from '@floway-dev/protocols/dump';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

const props = defineProps<{
  keyId: string;
  recordId: string | null;
}>();

const record = shallowRef<DumpRecord | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// Per-fetch token: only the latest call is allowed to commit. Stale A→B clicks
// must not paint A's response on top of B's.
let activeToken = 0;

const fetchRecord = async () => {
  if (props.recordId === null) {
    record.value = null;
    error.value = null;
    loading.value = false;
    return;
  }
  const token = ++activeToken;
  loading.value = true;
  error.value = null;
  try {
    const res = await authFetch(`/api/dump/keys/${encodeURIComponent(props.keyId)}/records/${encodeURIComponent(props.recordId)}`);
    if (token !== activeToken) return;
    if (!res.ok) {
      error.value = `HTTP ${res.status}`;
      record.value = null;
      return;
    }
    record.value = await res.json() as DumpRecord;
  } catch (e: unknown) {
    if (token !== activeToken) return;
    error.value = e instanceof Error ? e.message : String(e);
    record.value = null;
  } finally {
    if (token === activeToken) loading.value = false;
  }
};

watch(() => [props.keyId, props.recordId], () => { void fetchRecord(); }, { immediate: true });

const SENSITIVE_HEADERS = new Set(['x-api-key', 'authorization']);

const isSensitiveHeader = (key: string) => SENSITIVE_HEADERS.has(key.toLowerCase());

const redact = (value: string): string => {
  if (value.length <= 20) return '•'.repeat(value.length);
  return `${value.slice(0, 8)}${'•'.repeat(value.length - 16)}${value.slice(-8)}`;
};

const revealedHeaders = ref<Set<string>>(new Set());

const toggleHeaderReveal = (kind: 'req' | 'res', index: number) => {
  const key = `${kind}:${index}`;
  const next = new Set(revealedHeaders.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  revealedHeaders.value = next;
};

const isRevealed = (kind: 'req' | 'res', index: number) => revealedHeaders.value.has(`${kind}:${index}`);

const contentTypeOf = (headers: Array<[string, string]>): string => {
  for (const [k, v] of headers) {
    if (k.toLowerCase() === 'content-type') return v;
  }
  return '';
};

const stripBase64Suffix = (contentType: string): { contentType: string; isBase64: boolean } => {
  const lower = contentType.toLowerCase().trim();
  if (lower.endsWith(';base64')) {
    return { contentType: contentType.slice(0, contentType.toLowerCase().lastIndexOf(';base64')), isBase64: true };
  }
  return { contentType, isBase64: false };
};

const decodeBase64Utf8 = (b64: string): { text: string; ok: boolean } => {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, ok: true };
  } catch {
    return { text: '', ok: false };
  }
};

interface RenderedBody {
  kind: 'json' | 'text' | 'binary';
  text: string;
  binaryWarning: boolean;
}

const renderBody = (rawBody: string, rawContentType: string): RenderedBody => {
  const { contentType, isBase64 } = stripBase64Suffix(rawContentType);
  if (rawBody.length === 0) return { kind: 'text', text: '', binaryWarning: false };

  if (isBase64) {
    const decoded = decodeBase64Utf8(rawBody);
    if (!decoded.ok) {
      return { kind: 'binary', text: rawBody, binaryWarning: true };
    }
    return renderTextBody(decoded.text, contentType);
  }
  return renderTextBody(rawBody, contentType);
};

const isJsonContentType = (ct: string): boolean => {
  const lower = ct.toLowerCase();
  return lower.includes('application/json')
    || lower.includes('+json')
    || lower.includes('application/x-ndjson');
};

const renderTextBody = (body: string, contentType: string): RenderedBody => {
  if (isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return { kind: 'json', text: JSON.stringify(parsed, null, 2), binaryWarning: false };
    } catch {
      return { kind: 'text', text: body, binaryWarning: false };
    }
  }
  return { kind: 'text', text: body, binaryWarning: false };
};

const requestBody = computed<RenderedBody | null>(() => {
  if (!record.value) return null;
  return renderBody(record.value.request.body, contentTypeOf(record.value.request.headers));
});

const streamView = ref<'collected' | 'events'>('collected');

const responseBodyRendered = computed<RenderedBody | null>(() => {
  if (!record.value) return null;
  const r = record.value.response;
  if (r.type !== 'bytes') return null;
  return renderBody(r.body, contentTypeOf(r.headers));
});

const streamEvents = computed<DumpStreamEvent[]>(() => {
  if (!record.value) return [];
  const r = record.value.response;
  return r.type === 'stream' ? r.events : [];
});

const collectKind = computed(() => record.value ? detectCollectKind(record.value.meta.path) : null);

const collected = computed<CollectOutcome | null>(() => {
  if (record.value?.response.type !== 'stream') return null;
  return collectByKind(collectKind.value, streamEvents.value);
});

const copiedSection = ref<string | null>(null);
const copy = async (text: string, section: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copiedSection.value = section;
    window.setTimeout(() => { if (copiedSection.value === section) copiedSection.value = null; }, 1500);
  } catch {
    /* clipboard denied — ignore so the operator can still drag-select. */
  }
};

const statusBadgeClass = (status: number, errorText: string | null): string => {
  if (status === 0 || errorText !== null) return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  if (status >= 500) return 'bg-accent-rose/15 text-accent-rose border-accent-rose/30';
  if (status >= 400) return 'bg-accent-amber/15 text-accent-amber border-accent-amber/30';
  if (status >= 200 && status < 300) return 'bg-accent-emerald/15 text-accent-emerald border-accent-emerald/30';
  return 'bg-surface-700 text-gray-400 border-white/10';
};

const formatTs = (ms: number) => {
  if (ms < 1) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const stickyHeader = 'sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-surface-900/85 px-4 py-2.5 backdrop-blur-md';
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="recordId === null" class="flex h-full items-center justify-center px-6 text-center text-sm text-gray-600">
      Select a request on the left to view details.
    </div>

    <div v-else-if="loading" class="flex h-full items-center justify-center gap-2 text-xs text-gray-500">
      <Spinner class="size-3.5" />
      Loading…
    </div>

    <div v-else-if="error" class="m-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ error }}
    </div>

    <OverlayScrollbars v-else-if="record" class="min-h-0 flex-1">
      <section>
        <header :class="stickyHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Request</span>
        </header>
        <div class="px-4 py-3">
          <p class="mb-2 font-mono text-xs text-gray-300">
            <span class="text-accent-cyan">{{ record.request.method }}</span>
            <span class="ml-2 break-all">{{ record.request.path }}</span>
          </p>
          <table class="w-full text-xs">
            <tbody class="divide-y divide-white/[0.03]">
              <tr v-for="(pair, i) in record.request.headers" :key="i">
                <td class="w-44 py-1.5 pr-3 align-top font-mono text-gray-500">{{ pair[0] }}</td>
                <td class="py-1.5 align-top font-mono text-gray-300">
                  <span class="break-all">
                    {{ isSensitiveHeader(pair[0]) && !isRevealed('req', i) ? redact(pair[1]) : pair[1] }}
                  </span>
                  <button
                    v-if="isSensitiveHeader(pair[0])"
                    type="button"
                    class="ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-gray-500 hover:bg-white/[0.06] hover:text-gray-200"
                    :title="isRevealed('req', i) ? 'Hide value' : 'Reveal value'"
                    @click="toggleHeaderReveal('req', i)"
                  >
                    <svg v-if="isRevealed('req', i)" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="m1 1 22 22" />
                    </svg>
                    <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="stickyHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Request body</span>
          <button
            v-if="requestBody && requestBody.text"
            type="button"
            class="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/[0.06] hover:text-gray-200"
            @click="copy(requestBody.text, 'req-body')"
          >
            {{ copiedSection === 'req-body' ? 'Copied' : 'Copy' }}
          </button>
        </header>
        <div class="px-4 py-3">
          <p v-if="!requestBody || !requestBody.text" class="text-xs text-gray-600">No request body.</p>
          <template v-else>
            <p v-if="requestBody.binaryWarning" class="mb-2 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Binary body; UTF-8 decoding failed. Showing base64.
            </p>
            <pre class="whitespace-pre-wrap break-all font-mono text-xs text-gray-300">{{ requestBody.text }}</pre>
          </template>
        </div>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="stickyHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Response</span>
          <span
            class="ml-2 inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold"
            :class="statusBadgeClass(record.response.status, record.meta.error)"
          >
            {{ record.response.status === 0 ? 'ERR' : record.response.status }}
          </span>
          <span v-if="record.meta.error" class="ml-2 truncate text-[11px] text-accent-rose" :title="record.meta.error">{{ record.meta.error }}</span>
        </header>
        <div class="px-4 py-3">
          <table v-if="record.response.headers.length > 0" class="w-full text-xs">
            <tbody class="divide-y divide-white/[0.03]">
              <tr v-for="(pair, i) in record.response.headers" :key="i">
                <td class="w-44 py-1.5 pr-3 align-top font-mono text-gray-500">{{ pair[0] }}</td>
                <td class="py-1.5 align-top font-mono text-gray-300 break-all">{{ pair[1] }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-xs text-gray-600">No response headers.</p>
        </div>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="stickyHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Response body</span>
          <template v-if="record.response.type === 'stream'">
            <div class="ml-auto inline-flex overflow-hidden rounded border border-white/[0.08]">
              <button
                type="button"
                class="px-2 py-0.5 text-[11px]"
                :class="streamView === 'collected' ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-gray-500 hover:text-gray-300'"
                @click="streamView = 'collected'"
              >
                Collected
              </button>
              <button
                type="button"
                class="px-2 py-0.5 text-[11px] border-l border-white/[0.08]"
                :class="streamView === 'events' ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-gray-500 hover:text-gray-300'"
                @click="streamView = 'events'"
              >
                Events ({{ streamEvents.length }})
              </button>
            </div>
          </template>
          <template v-else-if="record.response.type === 'bytes' && responseBodyRendered && responseBodyRendered.text">
            <button
              type="button"
              class="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/[0.06] hover:text-gray-200"
              @click="copy(responseBodyRendered.text, 'res-body')"
            >
              {{ copiedSection === 'res-body' ? 'Copied' : 'Copy' }}
            </button>
          </template>
        </header>
        <div class="px-4 py-3">
          <template v-if="record.response.type === 'none'">
            <p class="text-xs text-gray-600">No response body — request did not produce a response.</p>
          </template>

          <template v-else-if="record.response.type === 'bytes'">
            <p v-if="!responseBodyRendered || !responseBodyRendered.text" class="text-xs text-gray-600">Empty body.</p>
            <template v-else>
              <p v-if="responseBodyRendered.binaryWarning" class="mb-2 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
                Binary body; UTF-8 decoding failed. Showing base64.
              </p>
              <pre class="whitespace-pre-wrap break-all font-mono text-xs text-gray-300">{{ responseBodyRendered.text }}</pre>
            </template>
          </template>

          <template v-else-if="streamView === 'collected'">
            <p v-if="collectKind === null" class="mb-2 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              No protocol-specific collector for this path. Switch to "Events" to inspect raw frames.
            </p>
            <template v-else-if="collected">
              <p v-if="collected.error" class="mb-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
                Stream errored: {{ collected.error }}
              </p>
              <p v-else-if="collected.truncated" class="mb-2 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
                Output truncated by the upstream (length cap).
              </p>
              <pre v-if="collected.text" class="whitespace-pre-wrap break-words font-mono text-xs text-gray-300">{{ collected.text }}</pre>
              <p v-else-if="!collected.error" class="text-xs text-gray-600">No text recovered from the stream.</p>
            </template>
          </template>

          <template v-else>
            <ul class="space-y-2">
              <li
                v-for="(event, i) in streamEvents"
                :key="i"
                class="rounded-md border border-white/[0.04] bg-surface-800/40 px-3 py-2"
              >
                <div class="flex items-center gap-2 text-[11px]">
                  <span v-if="event.event" class="font-mono text-accent-cyan">{{ event.event }}</span>
                  <span v-else class="font-mono text-gray-600">(no event name)</span>
                  <span class="ml-auto font-mono text-gray-500">{{ formatTs(event.ts) }}</span>
                </div>
                <pre class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-gray-400">{{ event.data }}</pre>
              </li>
            </ul>
          </template>
        </div>
      </section>
    </OverlayScrollbars>
  </div>
</template>
