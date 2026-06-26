<script setup lang="ts">
// Editor for an alias's announced-metadata override — the operator's
// explicit `limits` + `chat` block that overrides the auto-computed
// intersection inside `synthesizeListedAliases`. v-model is the wire
// shape (`AnnouncedMetadata`), kind-gated:
//
//   - chat       → Limits + Modalities + Reasoning sub-blocks
//   - embedding  → Limits sub-block only
//   - image      → never mounted (the alias edit dialog hides the whole
//                  section for image-kind aliases)
//
// The three sub-blocks below mirror the matching ones in
// `apps/web/src/components/upstream-edit/ModelEditor.vue`. We accepted
// the duplication rather than attempting a full extraction of the
// catalog-side editor in the same PR — `ModelEditor.vue` ties those
// blocks to a wider state machine (config / editable / Manual vs
// Auto / per-model flag overrides) that doesn't carry over cleanly.
// A later cleanup pass can lift the shared bits into a single host.

import { computed, ref, watch } from 'vue';

import type { AliasKind, AnnouncedMetadata, ModelLimits, UpstreamChatConfig } from '../../api/types.ts';
import { Button, Input, Switch, Tooltip } from '@floway-dev/ui';

const modelValue = defineModel<AnnouncedMetadata>({ required: true });

const props = defineProps<{
  kind: AliasKind;
}>();

// Mutable local view of the wire payload. ChatModelInfo's modality
// arrays are typed `readonly`; the templates below build mutable
// copies that the wire shape accepts back without further coercion.
type EditableMetadata = { limits?: ModelLimits; chat?: UpstreamChatConfig };

const editable = computed<EditableMetadata>(() => modelValue.value as EditableMetadata);

const patch = (next: EditableMetadata) => {
  // Strip empty sub-blocks so the wire payload stays minimal — the
  // alias-listing fallback only kicks in for absent fields.
  const out: EditableMetadata = {};
  if (next.limits && Object.keys(next.limits).length > 0) out.limits = next.limits;
  if (next.chat && (next.chat.modalities !== undefined || next.chat.reasoning !== undefined)) out.chat = next.chat;
  modelValue.value = out as AnnouncedMetadata;
};

const parseOptionalNumber = (raw: string | number | null | undefined): number | undefined => {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
};

// ── Limits ─────────────────────────────────────────────────────────────

const updateLimit = (
  key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens',
  raw: string | number | null | undefined,
) => {
  const limits = { ...(editable.value.limits ?? {}) };
  const num = parseOptionalNumber(raw);
  if (num === undefined) delete limits[key];
  else limits[key] = num;
  patch({ ...editable.value, limits: Object.keys(limits).length > 0 ? limits : undefined });
};

// ── Chat builder helpers ───────────────────────────────────────────────

const buildNextChat = (partial: Partial<UpstreamChatConfig>): UpstreamChatConfig | undefined => {
  const base = editable.value.chat ?? {};
  const next: UpstreamChatConfig = { ...base, ...partial };

  const hasImageInput = next.modalities?.input.includes('image') === true;
  next.modalities = hasImageInput
    ? { input: ['text', 'image'], output: ['text'] }
    : undefined;

  if (!next.modalities && !next.reasoning) return undefined;
  return next;
};

const buildNextReasoning = (
  update: Partial<NonNullable<UpstreamChatConfig['reasoning']>>,
): UpstreamChatConfig['reasoning'] => {
  const base = editable.value.chat?.reasoning ?? {};
  const merged = { ...base, ...update };
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as NonNullable<UpstreamChatConfig['reasoning']>;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
};

const setChat = (chat: UpstreamChatConfig | undefined) => {
  patch({ ...editable.value, chat });
};

// ── Modalities ─────────────────────────────────────────────────────────

const chatImageInput = computed<boolean>(
  () => editable.value.chat?.modalities?.input.includes('image') ?? false,
);

const toggleImageInput = (on: boolean) => {
  setChat(buildNextChat({ modalities: on ? { input: ['text', 'image'], output: ['text'] } : undefined }));
};

// ── Reasoning sub-blocks ───────────────────────────────────────────────

const effortEnabled = computed(() => editable.value.chat?.reasoning?.effort !== undefined);
const budgetTokensEnabled = computed(() => editable.value.chat?.reasoning?.budget_tokens !== undefined);
const adaptiveEnabled = computed(() => editable.value.chat?.reasoning?.adaptive === true);
const mandatoryEnabled = computed(() => editable.value.chat?.reasoning?.mandatory === true);

const anyControlledEnabled = computed(() => effortEnabled.value || budgetTokensEnabled.value || adaptiveEnabled.value);
const controlledDisabled = computed(() => mandatoryEnabled.value);
const mandatoryDisabled = computed(() => anyControlledEnabled.value);

const supportedEfforts = computed<string[]>(
  () => editable.value.chat?.reasoning?.effort?.supported ?? [],
);

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const presetEffortLevels = computed(() => REASONING_LEVELS.filter(level => !supportedEfforts.value.includes(level)));

const reasoningLevelInput = ref('');

watch(() => props.kind, () => { reasoningLevelInput.value = ''; });

const toggleEffort = (on: boolean) => {
  const reasoning = on
    ? buildNextReasoning({ effort: { supported: ['low', 'medium', 'high'], default: 'medium' } })
    : buildNextReasoning({ effort: undefined });
  setChat(buildNextChat({ reasoning }));
};

const addReasoningLevel = (level: string) => {
  const trimmed = level.trim();
  if (trimmed === '') return;
  const current = supportedEfforts.value;
  if (current.includes(trimmed)) return;
  const updated = [...current, trimmed];
  const existing = editable.value.chat?.reasoning?.effort;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: updated, default: existing?.default ?? '' } }) }));
};

const removeReasoningLevel = (level: string) => {
  const current = supportedEfforts.value;
  const removedIndex = current.indexOf(level);
  const updated = current.filter(e => e !== level);
  const existingEffort = editable.value.chat?.reasoning?.effort;
  let nextDefault = existingEffort?.default ?? '';
  if (existingEffort?.default === level) {
    if (updated.length === 0) nextDefault = '';
    else if (removedIndex < updated.length) nextDefault = updated[removedIndex]!;
    else nextDefault = updated[updated.length - 1]!;
  }
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: updated, default: nextDefault } }) }));
};

const commitReasoningInput = () => {
  const trimmed = reasoningLevelInput.value.trim();
  if (trimmed === '') return;
  addReasoningLevel(trimmed);
  reasoningLevelInput.value = '';
};

const setDefaultEffort = (value: string) => {
  const current = supportedEfforts.value;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: current, default: value } }) }));
};

// ── Effort drag-to-reorder ─────────────────────────────────────────────

const draggedEffortIndex = ref<number | null>(null);
const dragOverEffortIndex = ref<number | null>(null);

const onEffortDragStart = (index: number, e: DragEvent) => {
  draggedEffortIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }
};

const onEffortDragOver = (index: number, e: DragEvent) => {
  if (draggedEffortIndex.value === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOverEffortIndex.value = index;
};

const onEffortDragLeave = (index: number) => {
  if (dragOverEffortIndex.value === index) dragOverEffortIndex.value = null;
};

const onEffortDrop = (index: number, e: DragEvent) => {
  e.preventDefault();
  const from = draggedEffortIndex.value;
  draggedEffortIndex.value = null;
  dragOverEffortIndex.value = null;
  if (from === null || from === index) return;
  const current = [...supportedEfforts.value];
  const [moved] = current.splice(from, 1);
  if (moved === undefined) return;
  current.splice(index, 0, moved);
  const existing = editable.value.chat?.reasoning?.effort;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: current, default: existing?.default ?? '' } }) }));
};

const onEffortDragEnd = () => {
  draggedEffortIndex.value = null;
  dragOverEffortIndex.value = null;
};

// ── Budget tokens ──────────────────────────────────────────────────────

const toggleBudgetTokens = (on: boolean) => {
  const reasoning = on
    ? buildNextReasoning({ budget_tokens: {} })
    : buildNextReasoning({ budget_tokens: undefined });
  setChat(buildNextChat({ reasoning }));
};

const updateBudgetTokensMin = (raw: string | number | null | undefined) => {
  const num = parseOptionalNumber(raw);
  const current = editable.value.chat?.reasoning?.budget_tokens ?? {};
  const next = { ...current };
  if (num === undefined) delete next.min; else next.min = num;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ budget_tokens: next }) }));
};

const updateBudgetTokensMax = (raw: string | number | null | undefined) => {
  const num = parseOptionalNumber(raw);
  const current = editable.value.chat?.reasoning?.budget_tokens ?? {};
  const next = { ...current };
  if (num === undefined) delete next.max; else next.max = num;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ budget_tokens: next }) }));
};

// ── Adaptive / Mandatory ───────────────────────────────────────────────

const toggleAdaptive = (on: boolean) => {
  const reasoning = on
    ? buildNextReasoning({ adaptive: true })
    : buildNextReasoning({ adaptive: undefined });
  setChat(buildNextChat({ reasoning }));
};

const toggleMandatory = (on: boolean) => {
  const reasoning = on
    ? buildNextReasoning({ mandatory: true })
    : buildNextReasoning({ mandatory: undefined });
  setChat(buildNextChat({ reasoning }));
};

const showChatBlocks = computed(() => props.kind === 'chat');
</script>

<template>
  <div class="space-y-6">
    <section>
      <div class="mb-3 flex items-baseline gap-3">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Limits</h4>
        <span class="text-[11px] text-gray-500">tokens — leave blank to inherit the computed intersection</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Context Window</span>
          <Input
            type="number"
            :model-value="editable.limits?.max_context_window_tokens"
            placeholder="e.g. 1050000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_context_window_tokens', v)"
          />
        </label>
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Prompt Tokens</span>
          <Input
            type="number"
            :model-value="editable.limits?.max_prompt_tokens"
            placeholder="e.g. 922000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_prompt_tokens', v)"
          />
        </label>
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Output Tokens</span>
          <Input
            type="number"
            :model-value="editable.limits?.max_output_tokens"
            placeholder="e.g. 128000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_output_tokens', v)"
          />
        </label>
      </div>
    </section>

    <section v-if="showChatBlocks">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Modalities</h4>
        <label class="flex cursor-pointer items-center gap-2">
          <Switch :model-value="chatImageInput" @update:model-value="v => toggleImageInput(v === true)" />
          <span class="text-xs" :class="chatImageInput ? 'text-white' : 'text-gray-500'">Image input</span>
        </label>
      </div>
    </section>

    <section v-if="showChatBlocks">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Reasoning</h4>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="effortEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleEffort(v === true)" />
          <span class="text-xs" :class="effortEnabled ? 'text-white' : 'text-gray-500'">Effort levels</span>
        </label>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="budgetTokensEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleBudgetTokens(v === true)" />
          <span class="text-xs" :class="budgetTokensEnabled ? 'text-white' : 'text-gray-500'">Budget tokens</span>
        </label>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="adaptiveEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleAdaptive(v === true)" />
          <span class="text-xs" :class="adaptiveEnabled ? 'text-white' : 'text-gray-500'">Adaptive</span>
          <Tooltip content="Model self-selects reasoning effort"><span class="text-[10px] text-gray-600">?</span></Tooltip>
        </label>
        <label class="flex items-center gap-2" :class="mandatoryDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="mandatoryEnabled" :disabled="mandatoryDisabled" @update:model-value="v => toggleMandatory(v === true)" />
          <span class="text-xs" :class="mandatoryEnabled ? 'text-white' : 'text-gray-500'">Mandatory</span>
          <Tooltip content="Reasoning is always applied; caller cannot opt out"><span class="text-[10px] text-gray-600">?</span></Tooltip>
        </label>
      </div>

      <div v-if="effortEnabled" class="mt-3 space-y-1.5 border-l-2 border-white/[0.08] pl-3">
        <div class="flex min-h-[1.625rem] flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="text-xs font-semibold text-gray-300">Effort levels</span>
          <span class="text-[11px] text-gray-500">(click to set default)</span>
          <template v-if="supportedEfforts.length > 0">
            <button
              v-for="(level, index) in supportedEfforts"
              :key="level"
              type="button"
              class="inline-flex cursor-grab items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] transition-colors active:cursor-grabbing"
              :class="[
                editable.chat?.reasoning?.effort?.default === level
                  ? 'border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan font-semibold'
                  : 'border-white/15 bg-white/[0.07] text-gray-300 hover:border-white/30 hover:text-white',
                draggedEffortIndex === index && 'opacity-40',
                dragOverEffortIndex === index && draggedEffortIndex !== index && 'ring-1 ring-accent-cyan',
              ]"
              draggable="true"
              :title="editable.chat?.reasoning?.effort?.default === level ? 'Default — click another to switch, drag to reorder' : 'Click to set as default, drag to reorder'"
              @click="setDefaultEffort(level)"
              @dragstart="e => onEffortDragStart(index, e)"
              @dragover="e => onEffortDragOver(index, e)"
              @dragleave="onEffortDragLeave(index)"
              @drop="e => onEffortDrop(index, e)"
              @dragend="onEffortDragEnd"
            >
              {{ level }}
              <span
                role="button"
                tabindex="0"
                class="ml-0.5 cursor-pointer text-gray-500 transition-colors hover:text-accent-rose"
                :aria-label="`Remove ${level}`"
                @click.stop="removeReasoningLevel(level)"
                @keydown.enter.stop.prevent="removeReasoningLevel(level)"
              >
                <svg class="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 3 3 9M3 3l6 6" />
                </svg>
              </span>
            </button>
          </template>
          <p v-else class="whitespace-nowrap text-[11px] text-accent-amber">Add at least one effort level — click a preset on the right.</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="level in presetEffortLevels"
            :key="level"
            type="button"
            class="rounded border border-white/15 px-2 py-0.5 font-mono text-[11px] text-gray-400 transition-colors hover:border-accent-cyan/40 hover:text-accent-cyan"
            @click="addReasoningLevel(level)"
          >+ {{ level }}</button>
          <Input
            v-model="reasoningLevelInput"
            size="sm"
            placeholder="custom…"
            class="!h-6 !w-28 !py-0 !text-[11px] font-mono"
            @keydown.enter.prevent="commitReasoningInput"
          />
          <Button variant="secondary" size="sm" class="!h-6 !px-2 !py-0 !text-[11px]" @click="commitReasoningInput">Add</Button>
        </div>
      </div>

      <div v-if="budgetTokensEnabled" class="mt-3 flex flex-wrap items-center gap-3 border-l-2 border-white/[0.08] pl-3">
        <span class="text-xs font-semibold text-gray-300">Budget tokens</span>
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-gray-500">Min</span>
          <Input
            type="number"
            min="0"
            size="sm"
            :model-value="editable.chat?.reasoning?.budget_tokens?.min"
            placeholder="—"
            class="!h-6 !w-24 !py-0 !text-[11px] font-mono"
            @update:model-value="v => updateBudgetTokensMin(v)"
          />
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-gray-500">Max</span>
          <Input
            type="number"
            min="0"
            size="sm"
            :model-value="editable.chat?.reasoning?.budget_tokens?.max"
            placeholder="—"
            class="!h-6 !w-24 !py-0 !text-[11px] font-mono"
            @update:model-value="v => updateBudgetTokensMax(v)"
          />
        </label>
        <p
          v-if="editable.chat?.reasoning?.budget_tokens?.min !== undefined
            && editable.chat?.reasoning?.budget_tokens?.max !== undefined
            && editable.chat.reasoning.budget_tokens.max < editable.chat.reasoning.budget_tokens.min"
          class="text-[11px] text-accent-amber"
        >
          Max must be ≥ min.
        </p>
      </div>
    </section>
  </div>
</template>
