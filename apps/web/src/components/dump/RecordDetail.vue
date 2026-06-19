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
// Per-header reveal state for sensitive request headers (x-api-key,
// authorization). Keyed by row index so repeated headers each toggle
// independently. Reset whenever a new record loads.
const revealedHeaderIdx = ref(new Set<number>());

const SENSITIVE_HEADERS = new Set(['x-api-key', 'authorization']);
const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.has(name.toLowerCase());
// Redact preserves length so the visual mass of the original value is
// preserved while the middle is hidden. The first and last 8 characters
// stay visible — enough for the operator to recognize the credential type
// and match the tail against their notes. Values of 16 or fewer chars are
// fully masked because there is no "middle".
const redactValue = (v: string): string => {
  if (v.length <= 16) return '•'.repeat(v.length);
  return v.slice(0, 8) + '•'.repeat(v.length - 16) + v.slice(-8);
};
const toggleReveal = (i: number) => {
  if (revealedHeaderIdx.value.has(i)) revealedHeaderIdx.value.delete(i);
  else revealedHeaderIdx.value.add(i);
  // Trigger reactivity (Sets don't deep-track mutation in Vue 3).
  revealedHeaderIdx.value = new Set(revealedHeaderIdx.value);
};

const fetchRecord = async (keyId: string, recordId: string) => {
  loading.value = true;
  error.value = null;
  record.value = null;
  revealedHeaderIdx.value = new Set();
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

interface DecodedBody { text: string; pretty: string | null; copyText: string; isJson: boolean; decodeError: string | null }

const decodeRequestBody = (req: DumpRequest): DecodedBody => {
  const ct = headerValue(req.headers, 'content-type') ?? '';
  if (/;\s*base64\s*$/i.test(ct)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(req.body), c => c.charCodeAt(0)),
      );
      return { text: decoded, pretty: null, copyText: decoded, isJson: false, decodeError: null };
    } catch (err) {
      // Decoding failed — surface the raw base64 alongside an explicit signal
      // so the operator can tell apart "we showed you the bytes" from
      // "the bytes already looked like base64".
      const msg = err instanceof Error ? err.message : String(err);
      return { text: req.body, pretty: null, copyText: req.body, isJson: false, decodeError: msg };
    }
  }
  if (isJsonContentType(ct)) {
    try {
      const pretty = JSON.stringify(JSON.parse(req.body), null, 2);
      return { text: req.body, pretty, copyText: pretty, isJson: true, decodeError: null };
    } catch { /* fall through */ }
  }
  return { text: req.body, pretty: null, copyText: req.body, isJson: false, decodeError: null };
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

    <!-- Outer scroll over the whole detail pane. Sections sit flush against
         each other with a single divider between them; each section's header
         is sticky so it stays pinned to the top of the scroll viewport while
         its body scrolls, and only gives way once the next section's header
         reaches the top. -->
    <OverlayScrollbars v-else-if="record" class="min-h-0 flex-1" no-tabindex>
      <div class="divide-y divide-white/[0.06]">
        <!-- Request headers -->
        <section>
          <header class="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">Request headers</span>
            <Button
              size="sm"
              :variant="copyFailed === 'req-headers' ? 'danger' : 'secondary'"
              @click="copyTo(requestHeadersCopy, 'req-headers')"
            >{{ copyLabel('req-headers') }}</Button>
          </header>
          <div class="px-3 py-2 text-xs">
            <div class="mb-2 flex items-center gap-2 font-mono">
              <span class="font-semibold text-white">{{ record.request.method }}</span>
              <span class="break-all text-gray-300">{{ record.request.path }}</span>
            </div>
            <table class="w-full">
              <tbody>
                <tr v-for="([k, v], i) in record.request.headers" :key="`${i}-${k}`" class="border-t border-white/[0.03]">
                  <td class="py-1 pr-3 align-top font-mono text-gray-500 whitespace-nowrap">{{ k }}</td>
                  <td class="py-1 align-top break-all font-mono text-gray-300">
                    <template v-if="isSensitiveHeader(k)">
                      <span>{{ revealedHeaderIdx.has(i) ? v : redactValue(v) }}</span><button
                        type="button"
                        class="ml-1 inline-flex size-4 items-center justify-center align-middle text-gray-600 hover:text-gray-300"
                        :aria-label="revealedHeaderIdx.has(i) ? 'Hide value' : 'Reveal value'"
                        :title="revealedHeaderIdx.has(i) ? 'Hide value' : 'Reveal value'"
                        @click="toggleReveal(i)"
                      >
                        <i :class="revealedHeaderIdx.has(i) ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-3.5" />
                      </button>
                    </template>
                    <template v-else>{{ v }}</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Request body -->
        <section>
          <header class="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">Request body</span>
            <Button
              v-if="requestBody"
              size="sm"
              :variant="copyFailed === 'req-body' ? 'danger' : 'secondary'"
              @click="copyTo(requestBody.copyText, 'req-body')"
            >{{ copyLabel('req-body') }}</Button>
          </header>
          <Code
            v-if="requestBody?.pretty"
            :code="requestBody.pretty"
            :language="requestBody.isJson ? 'json' : 'text'"
            :copyable="false"
          />
          <template v-else-if="requestBody">
            <div
              v-if="requestBody.decodeError"
              class="mx-3 mt-3 rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber"
            >Could not decode the request body ({{ requestBody.decodeError }}); showing raw base64 below.</div>
            <pre class="px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ requestBody.text }}</pre>
          </template>
          <p v-else class="px-3 py-4 text-center text-xs text-gray-500">No request body.</p>
        </section>

        <!-- Response headers + status -->
        <section>
          <header class="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
            <span class="text-xs font-medium text-gray-400">
              Response headers <span class="ml-2 font-mono text-gray-500">{{ formatStatus(record.response.status) }}</span>
            </span>
            <Button
              size="sm"
              :variant="copyFailed === 'res-headers' ? 'danger' : 'secondary'"
              @click="copyTo(responseHeadersCopy, 'res-headers')"
            >{{ copyLabel('res-headers') }}</Button>
          </header>
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
        </section>

        <!-- Response body -->
        <section>
          <header class="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-white/[0.06] bg-surface-800/95 px-3 py-2 backdrop-blur">
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

          <!-- bytes (non-stream) -->
          <template v-if="bytesView">
            <Code
              v-if="bytesView.pretty"
              :code="bytesView.pretty"
              :language="bytesView.isJson ? 'json' : 'text'"
              :copyable="false"
            />
            <pre v-else class="px-3 py-2 text-xs font-mono leading-relaxed text-gray-200">{{ bytesView.raw }}</pre>
          </template>

          <!-- stream → toggle -->
          <template v-else-if="record.response.type === 'stream'">
            <template v-if="streamView === 'collected'">
              <template v-if="collectedView && 'copyText' in collectedView">
                <div
                  v-if="collectedView.error"
                  class="mx-3 mt-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose"
                >Stream error: {{ collectedView.error }}</div>
                <div
                  v-else-if="collectedView.truncated"
                  class="mx-3 mt-3 rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber"
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
            <ul v-else class="divide-y divide-white/[0.04] text-xs">
              <li v-for="(ev, i) in eventsView" :key="i" class="px-3 py-2">
                <div class="flex items-center gap-2 text-[11px] text-gray-500">
                  <span class="font-mono text-accent-cyan">{{ ev.event ?? '(unlabeled)' }}</span>
                  <span class="text-gray-600">+{{ ev.ts }}ms</span>
                </div>
                <Code class="mt-1" :code="ev.pretty" language="json" :copyable="false" />
              </li>
            </ul>
          </template>

          <!-- none -->
          <p v-else class="px-3 py-4 text-center text-xs text-gray-500">
            No response body was produced.
            <span v-if="record.meta.error" class="mt-1 block text-accent-rose">{{ record.meta.error }}</span>
          </p>
        </section>
      </div>
    </OverlayScrollbars>
  </div>
</template>
