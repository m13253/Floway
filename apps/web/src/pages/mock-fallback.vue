<!--
  Standalone mock page for the upcoming colo-aware Proxy Fallback List panel.
  Public route — no auth needed. The component below is inlined (not yet
  extracted to a real component file) so we can iterate on the visual mock
  before committing to the production wiring. The Tailwind/Uno tokens,
  Sortable/Tooltip/TagCombobox/Popover imports, and color palette all match
  the production dashboard exactly.

  Open: http://localhost:5174/mock-fallback
-->
<script setup lang="ts">
import {
  PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger,
} from 'reka-ui';
import { computed, ref } from 'vue';

import { Sortable, TagCombobox, Tooltip } from '@floway-dev/ui';

definePage({ meta: { public: true } });

const DIRECT = 'direct';

interface ProxyRecord {
  id: string;
  name: string;
}
interface FallbackEntry {
  id: string;
  colos?: string[];
}
interface BackoffRow {
  proxyId: string;
  expiresInSec: number;
  failCount: number;
  lastError: string;
}

const mockProxies: ProxyRecord[] = [
  { id: 'p-jp-tokyo', name: 'jp-tokyo-trojan' },
  { id: 'p-us-west', name: 'us-west-vless' },
  { id: 'p-eu-ams', name: 'eu-amsterdam-ss' },
  { id: 'p-sg-sin', name: 'sg-singapore-reality' },
  { id: 'p-long', name: 'very-long-proxy-name-that-might-overflow-the-row-test' },
];

const COLO_OPTIONS = [
  'HKG', 'NRT', 'KIX', 'TPE', 'ICN', 'SIN', 'BKK', 'KUL',
  'LAX', 'SJC', 'SEA', 'DFW', 'ORD', 'IAD', 'EWR', 'YYZ',
  'LHR', 'CDG', 'AMS', 'FRA', 'MAD', 'MXP', 'WAW', 'ARN',
  'SYD', 'AKL', 'GRU', 'JNB', 'DXB', 'BOM', 'DEL',
].map(c => ({ value: c, label: c }));

const initialList: FallbackEntry[] = [
  { id: 'p-jp-tokyo', colos: ['NRT', 'KIX'] },
  { id: 'p-eu-ams' },
  { id: DIRECT, colos: ['NRT', 'LAX', 'AMS'] },
  { id: 'p-us-west', colos: ['LAX', 'SJC'] },
  { id: 'p-long' },
  { id: 'orphan-deleted-uuid', colos: ['HKG'] },
];

const list = ref<FallbackEntry[]>([...initialList]);
const backoffs = ref<BackoffRow[]>([
  { proxyId: 'p-jp-tokyo', expiresInSec: 47, failCount: 3, lastError: 'connect ETIMEDOUT 192.168.1.1:443' },
]);

// In production this comes from a backend API (whatever colo the dashboard's
// own request landed in). In the mock we let the operator pick to see how
// the highlight + toggle behave across colos.
const currentColo = ref<string>('HKG');
const currentColoHighlight = computed<string[]>(() => (currentColo.value ? [currentColo.value] : []));

const resetList = (): void => { list.value = [...initialList]; };
const toggleBackoff = (proxyId: string): void => {
  const idx = backoffs.value.findIndex(b => b.proxyId === proxyId);
  if (idx >= 0) backoffs.value.splice(idx, 1);
  else backoffs.value.push({ proxyId, expiresInSec: 30, failCount: 2, lastError: 'connect ECONNREFUSED 10.0.0.5:8388' });
};

const proxiesById = computed<Map<string, ProxyRecord>>(() =>
  new Map(mockProxies.map(p => [p.id, p])),
);
const backoffByProxyId = computed<Map<string, BackoffRow>>(() =>
  new Map(backoffs.value.map(b => [b.proxyId, b])),
);
const proxiesNotInList = computed<ProxyRecord[]>(() => {
  const used = new Set(list.value.map(e => e.id));
  return mockProxies.filter(p => !used.has(p.id));
});
const directInList = computed<boolean>(() => list.value.some(e => e.id === DIRECT));

const labelFor = (entry: FallbackEntry): string =>
  entry.id === DIRECT ? 'direct' : proxiesById.value.get(entry.id)?.name ?? entry.id;
const isOrphan = (entry: FallbackEntry): boolean =>
  entry.id !== DIRECT && !proxiesById.value.has(entry.id);

const removeAt = (index: number): void => { list.value.splice(index, 1); };
const append = (id: string): void => { list.value.push({ id }); };
const moveUp = (index: number): void => {
  if (index <= 0) return;
  const next = [...list.value];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  list.value = next;
};
const moveDown = (index: number): void => {
  if (index >= list.value.length - 1) return;
  const next = [...list.value];
  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
  list.value = next;
};

const setColosAt = (index: number, colos: string[]): void => {
  const entry = list.value[index]!;
  const deduped = Array.from(new Set(colos.map(c => c.trim().toUpperCase()).filter(c => c.length > 0)));
  list.value[index] = deduped.length === 0 ? { id: entry.id } : { id: entry.id, colos: deduped };
};
const toggleCurrentColoAt = (index: number): void => {
  if (!currentColo.value) return;
  const entry = list.value[index]!;
  const colos = entry.colos ?? [];
  if (colos.includes(currentColo.value)) setColosAt(index, colos.filter(c => c !== currentColo.value));
  else setColosAt(index, [...colos, currentColo.value]);
};

const formatBackoff = (b: BackoffRow): string =>
  `Backoff active · ${b.expiresInSec}s remaining · ${b.failCount} fail${b.failCount === 1 ? '' : 's'} · ${b.lastError}`;
</script>

<template>
  <div class="min-h-screen bg-surface-900 py-10">
    <div class="mx-auto max-w-2xl space-y-6 px-4">

      <!-- Mock control panel — not part of the production component -->
      <section class="rounded-2xl border border-white/[0.08] bg-surface-800/60 p-4">
        <p class="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Mock controls <span class="text-accent-violet">(dev-only)</span>
        </p>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-gray-500">Current colo (mock backend):</span>
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
            :class="backoffByProxyId.has(p.id)
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

      <!-- The actual panel: this block is what will become the real component -->
      <section class="rounded-2xl border border-white/[0.06] bg-surface-800/40 p-4">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Proxy Fallback List <span class="text-accent-cyan">({{ list.length }})</span>
          <span v-if="currentColo" class="ml-2 font-mono text-gray-500">
            · backend colo = <span class="text-accent-cyan">{{ currentColo }}</span>
          </span>
        </p>

        <div
          v-if="list.length === 0"
          class="rounded-md border border-dashed border-white/[0.08] bg-surface-900/40 px-3 py-2.5 text-xs text-gray-500"
        >
          No fallback list configured — defaults to direct.
        </div>

        <Sortable
          v-else
          v-model="list"
          tag="ul"
          handle=".drag-handle"
          class="divide-y divide-white/[0.06]"
          :item-key="(e: FallbackEntry) => e.id"
        >
          <template #default="{ item: entry, index }: { item: FallbackEntry; index: number }">
            <li
              class="flex items-center gap-2 px-1 py-2 text-sm"
            >
              <!-- LEFT: drag handle, always present -->
              <button
                type="button"
                class="drag-handle inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-gray-300 active:cursor-grabbing"
                aria-label="Drag to reorder"
                title="Drag to reorder"
              >
                <i class="i-lucide-grip-vertical size-3.5" />
              </button>

              <!-- MIDDLE: name + colo chips, flex-wrap on overflow -->
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  class="min-w-0 truncate"
                  :class="[
                    entry.id === DIRECT ? 'font-mono text-gray-300' : (isOrphan(entry) ? 'font-mono text-accent-rose' : 'text-white'),
                  ]"
                  :title="entry.id === DIRECT ? 'No proxy — connect directly' : entry.id"
                >
                  <template v-if="isOrphan(entry)">Unknown proxy · {{ entry.id }}</template>
                  <template v-else>{{ labelFor(entry) }}</template>
                </span>

                <PopoverRoot>
                  <PopoverTrigger as-child>
                    <button
                      type="button"
                      class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan/40"
                      :title="entry.colos?.length ? 'Click to edit colo whitelist' : 'Click to limit this entry to specific colos'"
                    >
                      <span
                        v-if="!entry.colos?.length"
                        class="rounded-md border border-dashed border-white/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                      >
                        All colos
                      </span>
                      <template v-else>
                        <span
                          v-for="c in entry.colos"
                          :key="c"
                          class="inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors"
                          :class="currentColo && currentColo === c
                            ? 'border-accent-cyan bg-surface-900 text-accent-cyan shadow-[0_0_8px_rgba(0,229,255,0.45)]'
                            : 'border-white/[0.1] bg-surface-600 text-gray-200'"
                        >{{ c }}</span>
                      </template>
                    </button>
                  </PopoverTrigger>
                  <PopoverPortal>
                    <PopoverContent
                      :side-offset="6"
                      align="start"
                      class="z-50 w-80 rounded-[10px] border border-white/[0.08] bg-surface-800 p-3 shadow-xl"
                    >
                      <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                        Colo whitelist
                      </p>

                      <TagCombobox
                        :model-value="entry.colos ?? []"
                        :items="COLO_OPTIONS"
                        :highlight="currentColoHighlight"
                        placeholder="HKG, NRT, AMS…"
                        empty-text="Type a 3-letter colo code and press Enter to add"
                        @update:model-value="(v: string[]) => setColosAt(index, v)"
                      />

                      <p class="mt-2 text-[10px] text-gray-500">
                        Empty = active in <span class="text-gray-300">all colos</span>.
                        Free-form codes accepted; suggestions are common CF colos.
                      </p>

                      <div class="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2 text-[10px] text-gray-500">
                        <span>Current colo:</span>
                        <button
                          v-if="currentColo"
                          type="button"
                          class="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium transition-all"
                          :class="(entry.colos ?? []).includes(currentColo)
                            ? 'border-accent-cyan bg-surface-900 text-accent-cyan shadow-[0_0_8px_rgba(0,229,255,0.45)] hover:shadow-[0_0_12px_rgba(0,229,255,0.6)]'
                            : 'border-dashed border-white/[0.2] bg-transparent text-gray-400 hover:border-accent-cyan/50 hover:text-accent-cyan'"
                          @click="toggleCurrentColoAt(index)"
                        >{{ currentColo }}</button>
                        <span v-else class="italic">unknown</span>
                        <span class="italic">(click to toggle)</span>
                      </div>

                      <PopoverArrow class="fill-surface-800" :width="10" :height="5" />
                    </PopoverContent>
                  </PopoverPortal>
                </PopoverRoot>
              </div>

              <!-- RIGHT: icons, always present -->
              <div class="flex shrink-0 items-center gap-0.5">
                <Tooltip
                  v-if="backoffByProxyId.get(entry.id)"
                  :content="formatBackoff(backoffByProxyId.get(entry.id)!)"
                >
                  <span
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-accent-amber transition-colors hover:bg-white/[0.04]"
                    aria-label="Backoff active"
                  >
                    <i class="i-lucide-triangle-alert size-3.5" />
                  </span>
                </Tooltip>

                <Tooltip content="Move up">
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                    :disabled="index === 0"
                    aria-label="Move entry up"
                    @click="moveUp(index)"
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="m18 15-6-6-6 6" />
                    </svg>
                  </button>
                </Tooltip>

                <Tooltip content="Move down">
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                    :disabled="index === list.length - 1"
                    aria-label="Move entry down"
                    @click="moveDown(index)"
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </Tooltip>

                <Tooltip content="Remove">
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
                    aria-label="Remove entry"
                    @click="removeAt(index)"
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </Tooltip>
              </div>
            </li>
          </template>
        </Sortable>

        <div class="mt-2">
          <DropdownMenuRoot>
            <DropdownMenuTrigger
              class="inline-flex h-9 w-full items-center justify-between rounded-[10px] border border-white/[0.06] bg-surface-700 px-3 text-sm text-gray-300 transition-colors hover:border-white/[0.1] focus:border-accent-cyan/50 focus:outline-none focus:ring-1 focus:ring-accent-cyan/30"
            >
              <span>+ Add proxy</span>
              <svg class="size-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent
                align="start"
                :side-offset="4"
                class="z-50 w-[var(--reka-dropdown-menu-trigger-width)] min-w-[8rem] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 p-1 text-white shadow-xl"
              >
                <DropdownMenuItem
                  v-if="!directInList"
                  class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 font-mono text-sm text-gray-300 outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
                  @select="append(DIRECT)"
                >direct</DropdownMenuItem>
                <DropdownMenuItem
                  v-for="p in proxiesNotInList"
                  :key="p.id"
                  class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
                  @select="append(p.id)"
                >{{ p.name }}</DropdownMenuItem>
                <p
                  v-if="proxiesNotInList.length === 0 && directInList"
                  class="px-2 py-1.5 text-xs text-gray-500"
                >All proxies already added.</p>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
        </div>
      </section>
    </div>
  </div>
</template>
