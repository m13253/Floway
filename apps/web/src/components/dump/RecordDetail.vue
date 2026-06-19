<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';

import type {
  DumpRecord,
  DumpRequest,
  DumpStreamEvent,
} from '@floway-dev/protocols/dump';
import {
  collectChatCompletionsStream,
  collectGeminiStream,
  collectMessagesStream,
  collectResponsesStream,
} from '@floway-dev/protocols/dump-collect';
import { Button, OverlayScrollbars, Spinner } from '@floway-dev/ui';

const props = defineProps<{
  keyId: string;
  recordId: string | null;
}>();

const record = shallowRef<DumpRecord | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const streamView = ref<'collected' | 'events'>('collected');
const copied = ref<string | null>(null);

const fetchRecord = async (keyId: string, recordId: string) => {
  loading.value = true;
  error.value = null;
  record.value = null;
  try {
    const res = await fetch(`/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    record.value = await res.json() as DumpRecord;
    streamView.value = 'collected';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
};

watch(() => [props.keyId, props.recordId] as const, ([keyId, recordId]) => {
  if (recordId === null) {
    record.value = null;
    return;
  }
  void fetchRecord(keyId, recordId);
}, { immediate: true });

const headerValue = (headers: Array<[string, string]>, name: string): string | null => {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
  return null;
};

const isJsonContentType = (ct: string | null) => !!ct && /\b(application\/json|application\/.*\+json)\b/i.test(ct);

interface DecodedBody {
  text: string;
  pretty: string | null;
  copyText: string;
}

const decodeRequestBody = (req: DumpRequest): DecodedBody => {
  const ct = headerValue(req.headers, 'content-type') ?? '';
  // Body is base64-encoded when the recorded content-type ends with `;base64`
  // (per the DumpRequest contract). Try to decode to UTF-8 text; fall back to
  // the raw base64 string when decoding fails (likely binary).
  if (/;\s*base64\s*$/i.test(ct)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(req.body), c => c.charCodeAt(0)),
      );
      return { text: decoded, pretty: null, copyText: decoded };
    } catch {
      return { text: req.body, pretty: null, copyText: req.body };
    }
  }
  if (isJsonContentType(ct)) {
    try {
      const pretty = JSON.stringify(JSON.parse(req.body), null, 2);
      return { text: req.body, pretty, copyText: pretty };
    } catch { /* fall through to raw */ }
  }
  return { text: req.body, pretty: null, copyText: req.body };
};

const requestBody = computed(() => record.value ? decodeRequestBody(record.value.request) : null);
const responseInfo = computed(() => record.value?.response ?? null);

const responseContentType = computed(() => {
  const r = responseInfo.value;
  return r ? headerValue(r.headers, 'content-type') : null;
});

interface BytesView {
  pretty: string | null;
  raw: string;
  copyText: string;
}

const bytesView = computed<BytesView | null>(() => {
  const r = responseInfo.value;
  if (!r || r.type !== 'bytes') return null;
  if (isJsonContentType(responseContentType.value)) {
    try {
      const pretty = JSON.stringify(JSON.parse(r.body), null, 2);
      return { pretty, raw: r.body, copyText: pretty };
    } catch { /* fall through */ }
  }
  return { pretty: null, raw: r.body, copyText: r.body };
});

interface CollectedView {
  text: string;
  copyText: string;
}

// Pick the right collect* function from the request path. Gemini uses
// `/v1beta/models/...:streamGenerateContent`; the others sit at well-known
// segments. count_tokens never reaches the dump middleware, so the
// `/messages` branch never sees that suffix.
const collectStream = (path: string, events: readonly DumpStreamEvent[]): unknown => {
  if (path.includes('/v1beta/models/')) return collectGeminiStream(events);
  if (path.includes('/chat/completions')) return collectChatCompletionsStream(events);
  if (path.includes('/responses')) return collectResponsesStream(events);
  if (path.includes('/messages')) return collectMessagesStream(events);
  throw new Error(`No collect strategy for path ${path}`);
};

const collectedView = computed<CollectedView | { error: string } | null>(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return null;
  try {
    const collected = collectStream(r.request.path, r.response.events);
    const text = JSON.stringify(collected, null, 2);
    return { text, copyText: text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

const eventsView = computed(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return null;
  return r.response.events.map(ev => ({
    event: ev.event,
    ts: ev.ts,
    pretty: tryPrettyJson(ev.data),
    raw: ev.data,
  }));
});

const tryPrettyJson = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
};

const eventsCopyText = computed(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return '';
  return r.response.events.map(ev => {
    const head = ev.event ? `event: ${ev.event}\n` : '';
    return `${head}data: ${ev.data}\n`;
  }).join('\n');
});

const requestHeadersCopy = computed(() => {
  const r = record.value;
  return r ? r.request.headers.map(([k, v]) => `${k}: ${v}`).join('\n') : '';
});

const responseHeadersCopy = computed(() => {
  const r = record.value;
  return r ? r.response.headers.map(([k, v]) => `${k}: ${v}`).join('\n') : '';
});

const copyTo = async (text: string, tag: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag;
    window.setTimeout(() => { if (copied.value === tag) copied.value = null; }, 1500);
  } catch { /* clipboard blocked; silent — the user sees no checkmark and tries again */ }
};

const formatStatus = (status: number) => status === 0 ? 'No response' : String(status);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b border-white/[0.05] px-4 py-3">
      <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Detail</span>
      <Spinner v-if="loading" class="size-3.5" />
    </header>

    <div v-if="error" class="m-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <p v-if="!recordId && !loading" class="px-4 py-10 text-center text-sm text-gray-500">
      Select a request to inspect.
    </p>

    <OverlayScrollbars v-if="record" class="min-h-0 flex-1" no-tabindex>
      <div class="space-y-4 p-4">
        <section class="glass-card overflow-hidden">
          <div class="sticky top-0 z-[1] flex items-center justify-between border-b border-white/[0.05] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">Request headers</span>
            <Button size="sm" variant="secondary" @click="copyTo(requestHeadersCopy, 'req-headers')">
              {{ copied === 'req-headers' ? 'Copied' : 'Copy' }}
            </Button>
          </div>
          <div class="px-3 py-2 text-xs">
            <div class="mb-2 flex items-center gap-2 font-mono">
              <span class="font-semibold text-white">{{ record.request.method }}</span>
              <span class="break-all text-gray-300">{{ record.request.path }}</span>
            </div>
            <table class="w-full">
              <tbody>
                <tr v-for="([k, v], i) in record.request.headers" :key="`${i}-${k}`" class="border-t border-white/[0.03]">
                  <td class="py-1 pr-3 align-top font-mono text-gray-500">{{ k }}</td>
                  <td class="py-1 align-top break-all font-mono text-gray-300">{{ v }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="requestBody" class="glass-card overflow-hidden">
          <div class="flex items-center justify-between border-b border-white/[0.05] px-3 py-2">
            <span class="text-xs font-medium text-gray-400">Request body</span>
            <Button size="sm" variant="secondary" @click="copyTo(requestBody.copyText, 'req-body')">
              {{ copied === 'req-body' ? 'Copied' : 'Copy' }}
            </Button>
          </div>
          <pre class="overflow-x-auto px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ requestBody.pretty ?? requestBody.text }}</pre>
        </section>

        <section class="glass-card overflow-hidden">
          <div class="flex items-center justify-between border-b border-white/[0.05] px-3 py-2">
            <span class="text-xs font-medium text-gray-400">
              Response headers <span class="ml-2 font-mono text-gray-500">{{ formatStatus(record.response.status) }}</span>
            </span>
            <Button size="sm" variant="secondary" @click="copyTo(responseHeadersCopy, 'res-headers')">
              {{ copied === 'res-headers' ? 'Copied' : 'Copy' }}
            </Button>
          </div>
          <div class="px-3 py-2 text-xs">
            <table class="w-full">
              <tbody>
                <tr v-for="([k, v], i) in record.response.headers" :key="`${i}-${k}`" class="border-t border-white/[0.03]">
                  <td class="py-1 pr-3 align-top font-mono text-gray-500">{{ k }}</td>
                  <td class="py-1 align-top break-all font-mono text-gray-300">{{ v }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="glass-card overflow-hidden">
          <div class="flex items-center justify-between border-b border-white/[0.05] px-3 py-2">
            <span class="text-xs font-medium text-gray-400">Response body</span>
            <div v-if="record.response.type === 'stream'" class="flex items-center gap-2">
              <div class="inline-flex rounded-md bg-surface-700 p-0.5 text-[11px]">
                <button
                  type="button"
                  class="rounded px-2 py-0.5 transition-colors"
                  :class="streamView === 'collected' ? 'bg-surface-500 text-white' : 'text-gray-400 hover:text-gray-200'"
                  @click="streamView = 'collected'"
                >Collected</button>
                <button
                  type="button"
                  class="rounded px-2 py-0.5 transition-colors"
                  :class="streamView === 'events' ? 'bg-surface-500 text-white' : 'text-gray-400 hover:text-gray-200'"
                  @click="streamView = 'events'"
                >Events</button>
              </div>
              <Button
                v-if="streamView === 'collected' && collectedView && 'copyText' in collectedView"
                size="sm" variant="secondary"
                @click="copyTo(collectedView.copyText, 'res-body')"
              >
                {{ copied === 'res-body' ? 'Copied' : 'Copy' }}
              </Button>
              <Button v-else-if="streamView === 'events'" size="sm" variant="secondary" @click="copyTo(eventsCopyText, 'res-body')">
                {{ copied === 'res-body' ? 'Copied' : 'Copy' }}
              </Button>
            </div>
            <Button v-else-if="bytesView" size="sm" variant="secondary" @click="copyTo(bytesView.copyText, 'res-body')">
              {{ copied === 'res-body' ? 'Copied' : 'Copy' }}
            </Button>
          </div>

          <template v-if="bytesView">
            <pre class="overflow-x-auto px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ bytesView.pretty ?? bytesView.raw }}</pre>
          </template>

          <template v-else-if="record.response.type === 'stream'">
            <template v-if="streamView === 'collected'">
              <pre v-if="collectedView && 'text' in collectedView" class="overflow-x-auto px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ collectedView.text }}</pre>
              <div v-else-if="collectedView && 'error' in collectedView" class="px-3 py-2 text-xs text-accent-rose">
                Could not collect stream: {{ collectedView.error }}
              </div>
            </template>
            <ul v-else class="divide-y divide-white/[0.04] text-xs">
              <li v-for="(ev, i) in eventsView" :key="i" class="px-3 py-2">
                <div class="flex items-center gap-2 text-[11px] text-gray-500">
                  <span class="font-mono text-accent-cyan">{{ ev.event ?? '(unlabeled)' }}</span>
                  <span class="text-gray-600">+{{ ev.ts }}ms</span>
                </div>
                <pre class="mt-1 overflow-x-auto font-mono text-gray-300">{{ ev.pretty }}</pre>
              </li>
            </ul>
          </template>

          <template v-else>
            <p class="px-3 py-4 text-center text-xs text-gray-500">
              No response body was produced.
              <span v-if="record.meta.error" class="mt-1 block text-accent-rose">{{ record.meta.error }}</span>
            </p>
          </template>
        </section>
      </div>
    </OverlayScrollbars>
  </div>
</template>
