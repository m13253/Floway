<script setup lang="ts">
import { computed, ref, shallowRef, watch, watchEffect } from 'vue';

import { statusBadgeClass } from './badge.ts';
import HeaderTable from './HeaderTable.vue';
import { authFetch } from '../../api/client.ts';
import { collectByKind, type CollectKind, type CollectOutcome, detectCollectKind } from '@floway-dev/gateway/dump-collect';
import type { DumpBody, DumpRecord, DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import { chatCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import { geminiProtocolFrameToSSEFrame } from '@floway-dev/protocols/gemini';
import { messagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/messages';
import { responsesProtocolFrameToSSEFrame } from '@floway-dev/protocols/responses';
import { Code, OverlayScrollbars, Spinner } from '@floway-dev/ui';

const props = defineProps<{
  keyId: string;
  recordId: string | null;
}>();

const record = shallowRef<DumpRecord | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const streamView = ref<'collected' | 'events'>('collected');

// Stale A->B clicks must not paint A's response on top of B's.
// Only the latest call commits.
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
  streamView.value = 'collected';
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

watch(() => [props.keyId, props.recordId], () => {
  void fetchRecord();
}, { immediate: true });

const contentTypeOf = (headers: Array<[string, string]>): string => {
  for (const [k, v] of headers) {
    if (k.toLowerCase() === 'content-type') return v;
  }
  return '';
};

const decodeBase64Utf8 = (b64: string): { text: string; error: string | null } => {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, error: null };
  } catch (e) {
    return { text: '', error: e instanceof Error ? e.message : String(e) };
  }
};

interface RenderedBody {
  text: string;
  decodeError: string | null;
  parseError: string | null;
  isJson: boolean;
}

const renderBody = (body: DumpBody, contentType: string): RenderedBody => {
  if (body.data.length === 0) return { text: '', decodeError: null, parseError: null, isJson: false };
  if (body.encoding === 'utf8') return renderTextBody(body.data, contentType);
  const decoded = decodeBase64Utf8(body.data);
  if (decoded.error !== null) return { text: body.data, decodeError: decoded.error, parseError: null, isJson: false };
  return renderTextBody(decoded.text, contentType);
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
      return { text: JSON.stringify(parsed, null, 2), decodeError: null, parseError: null, isJson: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { text: body, decodeError: null, parseError: message, isJson: false };
    }
  }
  return { text: body, decodeError: null, parseError: null, isJson: false };
};

const requestBody = computed<RenderedBody | null>(() => {
  if (!record.value) return null;
  return renderBody(record.value.request.body, contentTypeOf(record.value.request.headers));
});

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

// Per-protocol SSE serializer. Stored frames are protocol-typed but
// `DumpStreamEvent.frame` carries them as `ProtocolFrame<unknown>`; the
// serializer dispatch + per-frame call is the cold reverse of what the
// gateway's respond layer does live.
const frameToSse = (kind: CollectKind | null, frame: ProtocolFrame<unknown>): SseFrame | null => {
  try {
    switch (kind) {
    case 'messages':         return messagesProtocolFrameToSSEFrame(frame as Parameters<typeof messagesProtocolFrameToSSEFrame>[0]);
    case 'chat-completions': return chatCompletionsProtocolFrameToSSEFrame(frame as Parameters<typeof chatCompletionsProtocolFrameToSSEFrame>[0], { includeUsageChunk: true });
    case 'responses':        return responsesProtocolFrameToSSEFrame(frame as Parameters<typeof responsesProtocolFrameToSSEFrame>[0]);
    case 'gemini':           return geminiProtocolFrameToSSEFrame(frame as Parameters<typeof geminiProtocolFrameToSSEFrame>[0]);
    default:                 return null;
    }
  } catch (e) {
    return { type: 'sse', event: 'serialize_error', data: e instanceof Error ? e.message : String(e) };
  }
};

// Pretty-print each event's serialized SSE data as JSON when it parses;
// otherwise pass the raw payload through with the parse-error captured.
// Computed once per record so the v-for doesn't re-parse on every render.
// Most upstream SSE protocols (Messages, Responses, chat-completions)
// frame every data line as JSON, so a parse failure is operator-actionable
// — surface it via a chip in the event header rather than silently
// rendering as raw text.
const eventsRendered = computed(() => {
  const kind = collectKind.value;
  return streamEvents.value.map(ev => {
    const sse = frameToSse(kind, ev.frame);
    if (sse === null) return { event: null, ts: ev.ts, pretty: '', parseError: null as string | null };
    try {
      return { event: sse.event, ts: ev.ts, pretty: JSON.stringify(JSON.parse(sse.data), null, 2), parseError: null as string | null };
    } catch (e) {
      return { event: sse.event, ts: ev.ts, pretty: sse.data, parseError: e instanceof Error ? e.message : String(e) };
    }
  });
});

// A frame with no event name is an SSE 'message'-typed event, so omit
// the `event:` line entirely rather than emitting `event: \n`.
const eventsCopyText = computed(() => {
  const kind = collectKind.value;
  return streamEvents.value
    .map(ev => {
      const sse = frameToSse(kind, ev.frame);
      if (sse === null) return '';
      return `${sse.event ? `event: ${sse.event}\n` : ''}data: ${sse.data}\n`;
    })
    .filter(s => s.length > 0)
    .join('\n');
});

const collectKind = computed(() => record.value ? detectCollectKind(record.value.meta.path) : null);

// Folding is async (the shared reassembler consumes an AsyncIterable);
// drive it through a watch so the `collected` ref settles on each event
// or kind change.
const collected = shallowRef<CollectOutcome<unknown> | null>(null);
watchEffect(() => {
  if (record.value?.response.type !== 'stream' || collectKind.value === null) {
    collected.value = null;
    return;
  }
  const kind = collectKind.value;
  const events = streamEvents.value;
  void collectByKind(kind, events).then(outcome => {
    // Skip stale settlements: a newer trigger may have already kicked off
    // another fold for a different record.
    if (collectKind.value === kind && streamEvents.value === events) {
      collected.value = outcome;
    }
  });
});

const collectedJson = computed<string | null>(() => {
  if (collected.value === null || collected.value.result === null) return null;
  return JSON.stringify(collected.value.result, null, 2);
});

const requestHeadersCopy = computed(() => record.value
  ? record.value.request.headers.map(([k, v]) => `${k}: ${v}`).join('\n')
  : '');

const responseHeadersCopy = computed(() => record.value
  ? record.value.response.headers.map(([k, v]) => `${k}: ${v}`).join('\n')
  : '');

const copyState = ref<string | null>(null);
const copy = async (text: string, section: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copyState.value = section;
  } catch {
    copyState.value = `error:${section}`;
  }
  window.setTimeout(() => {
    if (copyState.value === section || copyState.value === `error:${section}`) copyState.value = null;
  }, 1500);
};
const copyLabelFor = (section: string): string => {
  if (copyState.value === section) return 'Copied';
  if (copyState.value === `error:${section}`) return 'Copy failed';
  return 'Copy';
};
const copyDangerFor = (section: string): boolean => copyState.value === `error:${section}`;

const formatTs = (ms: number) => {
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

// `status === 0` is the gateway's sentinel for "no response was produced"
// (transport failure, abort before bytes, dial error).
const statusLabel = (status: number): string => status === 0 ? 'No response' : String(status);

const sectionHeader = 'sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-surface-900/85 px-4 py-2.5 backdrop-blur-md';
const copyBtn = 'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors hover:bg-white/[0.06]';
const copyBtnNeutral = 'text-gray-400 hover:text-gray-200';
const copyBtnDanger = 'border border-accent-rose/40 bg-accent-rose/10 text-accent-rose';
const copyBtnClass = (section: string) => `${copyBtn} ${copyDangerFor(section) ? copyBtnDanger : copyBtnNeutral}`;
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

    <OverlayScrollbars v-else-if="record" class="min-h-0 flex-1" no-tabindex>
      <section>
        <header :class="sectionHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Request</span>
          <span class="ml-3 font-mono text-xs text-accent-cyan">{{ record.request.method }}</span>
          <span class="ml-1 min-w-0 truncate font-mono text-xs text-gray-300" :title="record.request.path">{{ record.request.path }}</span>
          <button type="button" :class="`ml-auto ${copyBtnClass('req-headers')}`" @click="copy(requestHeadersCopy, 'req-headers')">
            {{ copyLabelFor('req-headers') }}
          </button>
        </header>
        <div class="px-4 py-2">
          <HeaderTable :key="`req:${record.meta.id}`" :headers="record.request.headers" />
        </div>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="sectionHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Request body</span>
          <button v-if="requestBody && requestBody.text" type="button" :class="`ml-auto ${copyBtnClass('req-body')}`" @click="copy(requestBody.text, 'req-body')">
            {{ copyLabelFor('req-body') }}
          </button>
        </header>
        <div v-if="!requestBody || !requestBody.text" class="px-4 py-3 text-xs text-gray-600">No request body.</div>
        <template v-else>
          <p v-if="requestBody.decodeError" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
            Could not decode the request body ({{ requestBody.decodeError }}); showing raw base64 below.
          </p>
          <p v-if="requestBody.parseError" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
            Content-type declared JSON but the body did not parse ({{ requestBody.parseError }}); showing raw text below.
          </p>
          <Code flush :code="requestBody.text" :language="requestBody.isJson ? 'json' : 'text'" :copyable="false" />
        </template>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="sectionHeader">
          <span class="text-xs font-medium uppercase tracking-widest text-gray-500">Response</span>
          <span
            class="ml-2 inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold"
            :class="statusBadgeClass(record.response.status, record.meta.error)"
          >
            {{ statusLabel(record.response.status) }}
          </span>
          <span v-if="record.meta.error" class="ml-2 min-w-0 truncate text-[11px] text-accent-rose" :title="record.meta.error">{{ record.meta.error }}</span>
          <button v-if="record.response.headers.length > 0" type="button" :class="`ml-auto ${copyBtnClass('res-headers')}`" @click="copy(responseHeadersCopy, 'res-headers')">
            {{ copyLabelFor('res-headers') }}
          </button>
        </header>
        <div class="px-4 py-2">
          <HeaderTable v-if="record.response.headers.length > 0" :key="`res:${record.meta.id}`" :headers="record.response.headers" />
          <p v-else class="text-xs text-gray-600">No response headers.</p>
        </div>
      </section>

      <section class="border-t border-white/[0.06]">
        <header :class="sectionHeader">
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
            <button v-if="streamView === 'events'" type="button" :class="`ml-2 ${copyBtnClass('res-events')}`" @click="copy(eventsCopyText, 'res-events')">
              {{ copyLabelFor('res-events') }}
            </button>
          </template>
          <template v-else-if="record.response.type === 'bytes' && responseBodyRendered && responseBodyRendered.text">
            <button type="button" :class="`ml-auto ${copyBtnClass('res-body')}`" @click="copy(responseBodyRendered.text, 'res-body')">
              {{ copyLabelFor('res-body') }}
            </button>
          </template>
        </header>

        <template v-if="record.response.type === 'none'">
          <p class="px-4 py-3 text-xs text-gray-600">No response body — request did not produce a response.</p>
        </template>

        <template v-else-if="record.response.type === 'bytes'">
          <p v-if="!responseBodyRendered || !responseBodyRendered.text" class="px-4 py-3 text-xs text-gray-600">Empty body.</p>
          <template v-else>
            <p v-if="responseBodyRendered.decodeError" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Could not decode the response body ({{ responseBodyRendered.decodeError }}); showing raw base64 below.
            </p>
            <p v-if="responseBodyRendered.parseError" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Content-type declared JSON but the body did not parse ({{ responseBodyRendered.parseError }}); showing raw text below.
            </p>
            <Code flush :code="responseBodyRendered.text" :language="responseBodyRendered.isJson ? 'json' : 'text'" :copyable="false" />
          </template>
        </template>

        <template v-else-if="streamView === 'collected'">
          <p v-if="collectKind === null" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
            No protocol-specific collector for this path. Switch to "Events" to inspect raw frames.
          </p>
          <template v-else-if="collected">
            <p v-if="collected.error" class="mx-4 mt-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
              Stream errored: {{ collected.error }}
            </p>
            <p v-else-if="collected.truncated" class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Output truncated by the upstream (length cap).
            </p>
            <p
              v-for="(warning, i) in collected.warnings"
              :key="`warn:${i}`"
              class="mx-4 mt-3 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-[11px] font-mono text-accent-amber"
            >
              {{ warning }}
            </p>
            <Code v-if="collectedJson !== null" flush :code="collectedJson" language="json" :copyable="false" />
            <p v-else-if="!collected.error" class="px-4 py-3 text-xs text-gray-600">No structured result recovered from the stream.</p>
          </template>
        </template>

        <template v-else>
          <ul class="divide-y divide-white/[0.04]">
            <li v-for="(event, i) in eventsRendered" :key="i">
              <div class="flex items-center gap-2 px-4 pt-2 text-[11px]">
                <span v-if="event.event" class="font-mono text-accent-cyan">{{ event.event }}</span>
                <span v-else class="font-mono text-gray-600">(unlabeled)</span>
                <span
                  v-if="event.parseError"
                  class="rounded border border-accent-rose/40 bg-accent-rose/10 px-1.5 py-0.5 font-mono text-[10px] text-accent-rose"
                  :title="event.parseError"
                >
                  JSON parse failed
                </span>
                <span class="ml-auto font-mono text-gray-500">+{{ formatTs(event.ts) }}</span>
              </div>
              <Code flush :code="event.pretty" :language="event.parseError ? 'text' : 'json'" :copyable="false" />
            </li>
          </ul>
        </template>
      </section>
    </OverlayScrollbars>
  </div>
</template>
