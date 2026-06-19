<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';

import { authFetch } from '../../api/client.ts';

import type {
  DumpRecord,
  DumpRequest,
  DumpStreamEvent,
} from '@floway-dev/protocols/dump';
import type { CollectOutcome } from '@floway-dev/protocols/dump-collect';
import {
  collectChatCompletionsStream,
  collectGeminiStream,
  collectMessagesStream,
  collectResponsesStream,
} from '@floway-dev/protocols/dump-collect';
import { Button, Code, OverlayScrollbars, Spinner } from '@floway-dev/ui';

const props = defineProps<{
  keyId: string;
  recordId: string | null;
}>();

const record = shallowRef<DumpRecord | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const streamView = ref<'collected' | 'events'>('collected');
const copied = ref<string | null>(null);
const copyFailed = ref<string | null>(null);

const fetchRecord = async (keyId: string, recordId: string) => {
  loading.value = true;
  error.value = null;
  record.value = null;
  try {
    const res = await authFetch(`/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}`);
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

interface DecodedBody { text: string; pretty: string | null; copyText: string; isJson: boolean }

const decodeRequestBody = (req: DumpRequest): DecodedBody => {
  const ct = headerValue(req.headers, 'content-type') ?? '';
  if (/;\s*base64\s*$/i.test(ct)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(req.body), c => c.charCodeAt(0)),
      );
      return { text: decoded, pretty: null, copyText: decoded, isJson: false };
    } catch {
      return { text: req.body, pretty: null, copyText: req.body, isJson: false };
    }
  }
  if (isJsonContentType(ct)) {
    try {
      const pretty = JSON.stringify(JSON.parse(req.body), null, 2);
      return { text: req.body, pretty, copyText: pretty, isJson: true };
    } catch { /* fall through */ }
  }
  return { text: req.body, pretty: null, copyText: req.body, isJson: false };
};

const requestBody = computed(() => record.value ? decodeRequestBody(record.value.request) : null);
const responseInfo = computed(() => record.value?.response ?? null);

const responseContentType = computed(() => {
  const r = responseInfo.value;
  return r ? headerValue(r.headers, 'content-type') : null;
});

interface BytesView { pretty: string | null; raw: string; copyText: string; isJson: boolean }

const bytesView = computed<BytesView | null>(() => {
  const r = responseInfo.value;
  if (!r || r.type !== 'bytes') return null;
  if (isJsonContentType(responseContentType.value)) {
    try {
      const pretty = JSON.stringify(JSON.parse(r.body), null, 2);
      return { pretty, raw: r.body, copyText: pretty, isJson: true };
    } catch { /* fall through */ }
  }
  return { pretty: null, raw: r.body, copyText: r.body, isJson: false };
});

interface CollectedView {
  resultText: string | null;
  copyText: string;
  error: string | null;
  truncated: boolean;
}

const collectStream = (path: string, events: readonly DumpStreamEvent[]): CollectOutcome<unknown> => {
  if (path.includes('/v1beta/models/')) return collectGeminiStream(events);
  if (path.includes('/chat/completions')) return collectChatCompletionsStream(events);
  if (path.includes('/responses')) return collectResponsesStream(events);
  if (path.includes('/messages')) return collectMessagesStream(events);
  throw new Error(`No collect strategy for path ${path}`);
};

const collectedView = computed<CollectedView | { thrown: string } | null>(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return null;
  try {
    const outcome = collectStream(r.request.path, r.response.events);
    const resultText = outcome.result === null ? null : JSON.stringify(outcome.result, null, 2);
    const copyText = resultText ?? outcome.error ?? '';
    return { resultText, copyText, error: outcome.error, truncated: outcome.truncated };
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
});

const eventsView = computed(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return null;
  return r.response.events.map(ev => ({
    event: ev.event,
    ts: ev.ts,
    pretty: tryPrettyJson(ev.data),
  }));
});

const tryPrettyJson = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return raw; }
};

const eventsCopyText = computed(() => {
  const r = record.value;
  if (r?.response.type !== 'stream') return '';
  return r.response.events.map(ev => `${ev.event ? `event: ${ev.event}\n` : ''}data: ${ev.data}\n`).join('\n');
});

const requestHeadersCopy = computed(() => record.value
  ? record.value.request.headers.map(([k, v]) => `${k}: ${v}`).join('\n')
  : '');
const responseHeadersCopy = computed(() => record.value
  ? record.value.response.headers.map(([k, v]) => `${k}: ${v}`).join('\n')
  : '');

const copyTo = async (text: string, tag: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag;
    window.setTimeout(() => { if (copied.value === tag) copied.value = null; }, 1500);
  } catch (err) {
    console.error('[clipboard]', err);
    copyFailed.value = tag;
    window.setTimeout(() => { if (copyFailed.value === tag) copyFailed.value = null; }, 2000);
  }
};

const copyLabel = (tag: string) => {
  if (copyFailed.value === tag) return 'Copy failed';
  if (copied.value === tag) return 'Copied';
  return 'Copy';
};

const formatStatus = (status: number) => status === 0 ? 'No response' : String(status);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="loading && !record" class="flex items-center justify-center gap-2 py-10 text-xs text-gray-500">
      <Spinner class="size-3.5" /> Loading…
    </div>

    <div v-else-if="error" class="m-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <p v-else-if="!recordId" class="px-4 py-10 text-center text-sm text-gray-500">
      Select a request to inspect.
    </p>

    <!-- Outer scroll over the whole detail pane. Each section renders at its
         natural height up to a generous max so a long body can scroll inside
         without pushing the page to a huge total scroll distance. -->
    <OverlayScrollbars v-else-if="record" class="min-h-0 flex-1" no-tabindex>
      <div class="flex flex-col gap-3 p-4">
        <!-- Request headers -->
        <section class="glass-card flex flex-col overflow-hidden">
          <header class="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">Request headers</span>
            <Button
              size="sm"
              :variant="copyFailed === 'req-headers' ? 'danger' : 'secondary'"
              @click="copyTo(requestHeadersCopy, 'req-headers')"
            >{{ copyLabel('req-headers') }}</Button>
          </header>
          <OverlayScrollbars class="max-h-[70vh]" no-tabindex>
            <div class="px-3 py-2 text-xs">
              <div class="mb-2 flex items-center gap-2 font-mono">
                <span class="font-semibold text-white">{{ record.request.method }}</span>
                <span class="break-all text-gray-300">{{ record.request.path }}</span>
              </div>
              <table class="w-full">
                <tbody>
                  <tr v-for="([k, v], i) in record.request.headers" :key="`${i}-${k}`" class="border-t border-white/[0.03]">
                    <td class="py-1 pr-3 align-top font-mono text-gray-500 whitespace-nowrap">{{ k }}</td>
                    <td class="py-1 align-top break-all font-mono text-gray-300">{{ v }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </OverlayScrollbars>
        </section>

        <!-- Request body -->
        <section class="glass-card flex flex-col overflow-hidden">
          <header class="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">Request body</span>
            <Button
              v-if="requestBody"
              size="sm"
              :variant="copyFailed === 'req-body' ? 'danger' : 'secondary'"
              @click="copyTo(requestBody.copyText, 'req-body')"
            >{{ copyLabel('req-body') }}</Button>
          </header>
          <div class="max-h-[70vh] overflow-hidden">
            <Code
              v-if="requestBody?.pretty"
              :code="requestBody.pretty"
              :language="requestBody.isJson ? 'json' : 'text'"
              :copyable="false"
            />
            <OverlayScrollbars v-else-if="requestBody" class="max-h-[70vh]" no-tabindex>
              <pre class="px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ requestBody.text }}</pre>
            </OverlayScrollbars>
            <p v-else class="px-3 py-4 text-center text-xs text-gray-500">No request body.</p>
          </div>
        </section>

        <!-- Response headers + status -->
        <section class="glass-card flex flex-col overflow-hidden">
          <header class="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">
              Response headers <span class="ml-2 font-mono text-gray-500">{{ formatStatus(record.response.status) }}</span>
            </span>
            <Button
              size="sm"
              :variant="copyFailed === 'res-headers' ? 'danger' : 'secondary'"
              @click="copyTo(responseHeadersCopy, 'res-headers')"
            >{{ copyLabel('res-headers') }}</Button>
          </header>
          <OverlayScrollbars class="max-h-[70vh]" no-tabindex>
            <div class="px-3 py-2 text-xs">
              <table class="w-full">
                <tbody>
                  <tr v-for="([k, v], i) in record.response.headers" :key="`${i}-${k}`" class="border-t border-white/[0.03]">
                    <td class="py-1 pr-3 align-top font-mono text-gray-500 whitespace-nowrap">{{ k }}</td>
                    <td class="py-1 align-top break-all font-mono text-gray-300">{{ v }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </OverlayScrollbars>
        </section>

        <!-- Response body -->
        <section class="glass-card flex flex-col overflow-hidden">
          <header class="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
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
                size="sm"
                :variant="copyFailed === 'res-body' ? 'danger' : 'secondary'"
                @click="copyTo(collectedView.copyText, 'res-body')"
              >{{ copyLabel('res-body') }}</Button>
              <Button
                v-else-if="streamView === 'events'"
                size="sm"
                :variant="copyFailed === 'res-body' ? 'danger' : 'secondary'"
                @click="copyTo(eventsCopyText, 'res-body')"
              >{{ copyLabel('res-body') }}</Button>
            </div>
            <Button
              v-else-if="bytesView"
              size="sm"
              :variant="copyFailed === 'res-body' ? 'danger' : 'secondary'"
              @click="copyTo(bytesView.copyText, 'res-body')"
            >{{ copyLabel('res-body') }}</Button>
          </header>

          <div class="max-h-[70vh] overflow-hidden">
            <!-- bytes (non-stream) -->
            <template v-if="bytesView">
              <Code
                v-if="bytesView.pretty"
                :code="bytesView.pretty"
                :language="bytesView.isJson ? 'json' : 'text'"
                :copyable="false"
              />
              <OverlayScrollbars v-else class="max-h-[70vh]" no-tabindex>
                <pre class="px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ bytesView.raw }}</pre>
              </OverlayScrollbars>
            </template>

            <!-- stream → toggle -->
            <template v-else-if="record.response.type === 'stream'">
              <template v-if="streamView === 'collected'">
                <template v-if="collectedView && 'copyText' in collectedView">
                  <div
                    v-if="collectedView.error"
                    class="mx-3 mt-3 shrink-0 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose"
                  >Stream error: {{ collectedView.error }}</div>
                  <div
                    v-else-if="collectedView.truncated"
                    class="mx-3 mt-3 shrink-0 rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber"
                  >Stream truncated — terminal frame missing. Showing best-effort accumulated state.</div>
                  <Code
                    v-if="collectedView.resultText !== null"
                    :code="collectedView.resultText"
                    language="json"
                    :copyable="false"
                  />
                  <p v-else class="px-3 py-4 text-center text-xs text-gray-500">No data could be reconstructed from the captured events.</p>
                </template>
                <div v-else-if="collectedView && 'thrown' in collectedView" class="px-3 py-2 text-xs text-accent-rose">
                  Could not collect stream: {{ collectedView.thrown }}
                </div>
              </template>
              <OverlayScrollbars v-else class="max-h-[70vh]" no-tabindex>
                <ul class="divide-y divide-white/[0.04] text-xs">
                  <li v-for="(ev, i) in eventsView" :key="i" class="px-3 py-2">
                    <div class="flex items-center gap-2 text-[11px] text-gray-500">
                      <span class="font-mono text-accent-cyan">{{ ev.event ?? '(unlabeled)' }}</span>
                      <span class="text-gray-600">+{{ ev.ts }}ms</span>
                    </div>
                    <Code class="mt-1" :code="ev.pretty" language="json" :copyable="false" />
                  </li>
                </ul>
              </OverlayScrollbars>
            </template>

            <!-- none -->
            <p v-else class="px-3 py-4 text-center text-xs text-gray-500">
              No response body was produced.
              <span v-if="record.meta.error" class="mt-1 block text-accent-rose">{{ record.meta.error }}</span>
            </p>
          </div>
        </section>
      </div>
    </OverlayScrollbars>
  </div>
</template>
