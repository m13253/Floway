<script setup lang="ts">
// Operator editor for one alias. The form is intentionally Goal-2-friendly:
// every "enum" field below is rendered as a plain text input with hints
// pulled from the target model's chat metadata (when available) and from
// well-known wire values. The dashboard never gates the value set so a new
// upstream-side level (e.g. an "xhigh" effort that shipped this morning)
// can flow through without a frontend release.

import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ModelAlias, ModelAliasOnConflict } from '../../api/types.ts';
import { useModelsStore } from '../../composables/useModels.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { Button, Checkbox, Dialog, Input, Select, TagCombobox } from '@floway-dev/ui';

// Mutable mirror of @floway-dev/protocols ModelAliasRules — the wire shape
// is `readonly` at the contract boundary, but the form mutates it in place
// while the operator is editing. The Hono RPC client expects the mutable
// version too.
interface MutableRules {
  reasoning?: {
    effort?: string;
    budgetTokens?: number;
    adaptive?: boolean;
    summary?: string;
  };
  verbosity?: string;
  serviceTier?: string;
  anthropicBeta?: string[];
}

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
  /** null = create; non-null = edit (alias is the PK, so editing it is disabled). */
  record: ModelAlias | null;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();
const modelsStore = useModelsStore();
const upstreamsStore = useUpstreamsStore();

const mode = computed<'create' | 'edit'>(() => (props.record ? 'edit' : 'create'));

// --- form state ---

const aliasName = ref(props.record?.alias ?? '');
const displayName = ref(props.record?.display_name ?? '');
const targetModelId = ref(props.record?.target_model_id ?? '');
const upstreamIds = ref<string[]>([...(props.record?.upstream_ids ?? [])]);
const visibleInModelsList = ref(props.record?.visible_in_models_list ?? true);
const onConflict = ref<ModelAliasOnConflict>(props.record?.on_conflict ?? 'real-only');

// Reasoning is modeled as a tagged radio + a separate summary input so the
// three approaches (effort preset / token budget / adaptive) are mutually
// exclusive in the wire shape but visible to the operator at a glance.
type ReasoningMode = 'none' | 'effort' | 'budget' | 'adaptive';

const initialReasoning = props.record?.rules.reasoning;
const initialReasoningMode: ReasoningMode = initialReasoning?.effort !== undefined
  ? 'effort'
  : initialReasoning?.budgetTokens !== undefined
    ? 'budget'
    : initialReasoning?.adaptive === true
      ? 'adaptive'
      : 'none';

const reasoningMode = ref<ReasoningMode>(initialReasoningMode);
const reasoningEffort = ref(initialReasoning?.effort ?? '');
const reasoningBudgetTokens = ref<string>(initialReasoning?.budgetTokens === undefined ? '' : String(initialReasoning.budgetTokens));
const reasoningSummary = ref(initialReasoning?.summary ?? '');

const verbosity = ref(props.record?.rules.verbosity ?? '');
const serviceTier = ref(props.record?.rules.serviceTier ?? '');
const anthropicBeta = ref<string[]>([...(props.record?.rules.anthropicBeta ?? [])]);

// --- suggestion sources ---
//
// Models list seeds the target-model combobox and feeds the reasoning hint
// lookup. `chat.reasoning` lives on per-model metadata the operator wired
// at upstream-config time; surface its supported effort list / budget range
// as combobox hints once a target id matches a real entry.

const modelOptions = computed(() => (modelsStore.models.value ?? []).map(m => ({
  value: m.id,
  label: m.display_name ?? m.id,
})));

const upstreamItems = computed(() => (upstreamsStore.upstreams.value ?? []).map(u => ({
  value: u.id,
  label: u.name,
  detail: u.id,
})));

const targetChat = computed(() => {
  const match = modelsStore.models.value?.find(m => m.id === targetModelId.value);
  return match && 'chat' in match ? (match as { chat?: { reasoning?: { effort?: { supported: string[] }; budget_tokens?: { min?: number; max?: number }; adaptive?: boolean } } }).chat : undefined;
});

const effortSuggestions = computed(() => targetChat.value?.reasoning?.effort?.supported ?? []);
const budgetMin = computed(() => targetChat.value?.reasoning?.budget_tokens?.min);
const budgetMax = computed(() => targetChat.value?.reasoning?.budget_tokens?.max);
const adaptiveSupported = computed(() => targetChat.value?.reasoning?.adaptive === true);

const SUMMARY_HINTS = ['auto', 'concise', 'detailed', 'omitted'];
const VERBOSITY_HINTS = ['low', 'medium', 'high'];
const SERVICE_TIER_HINTS = ['auto', 'default', 'flex', 'scale', 'priority', 'standard_only'];

const onConflictOptions: { value: ModelAliasOnConflict; label: string }[] = [
  { value: 'real-only', label: 'real-only — alias hidden when target id collides' },
  { value: 'alias-only', label: 'alias-only — alias replaces a colliding real id' },
  { value: 'both-real-first', label: 'both — real first' },
  { value: 'both-alias-first', label: 'both — alias first' },
];

// --- save ---

const saving = ref(false);
const saveError = ref<string | null>(null);

const trimOrUndef = (s: string): string | undefined => {
  const t = s.trim();
  return t === '' ? undefined : t;
};

const buildRules = (): MutableRules | { error: string } => {
  const rules: MutableRules = {};

  if (reasoningMode.value === 'effort') {
    const v = trimOrUndef(reasoningEffort.value);
    if (v === undefined) return { error: 'Reasoning effort cannot be empty' };
    rules.reasoning = { effort: v };
  } else if (reasoningMode.value === 'budget') {
    const raw = reasoningBudgetTokens.value.trim();
    if (raw === '' || !/^\d+$/.test(raw)) return { error: 'Reasoning budget tokens must be a non-negative integer' };
    rules.reasoning = { budgetTokens: Number(raw) };
  } else if (reasoningMode.value === 'adaptive') {
    rules.reasoning = { adaptive: true };
  }

  const summary = trimOrUndef(reasoningSummary.value);
  if (summary !== undefined) {
    rules.reasoning = { ...(rules.reasoning ?? {}), summary };
  }

  const verb = trimOrUndef(verbosity.value);
  if (verb !== undefined) rules.verbosity = verb;
  const tier = trimOrUndef(serviceTier.value);
  if (tier !== undefined) rules.serviceTier = tier;
  const betas = anthropicBeta.value.map(s => s.trim()).filter(s => s !== '');
  if (betas.length > 0) rules.anthropicBeta = betas;

  return rules;
};

const save = async () => {
  saveError.value = null;
  const trimmedAlias = aliasName.value.trim();
  const trimmedTarget = targetModelId.value.trim();
  if (mode.value === 'create' && trimmedAlias === '') { saveError.value = 'Alias name is required'; return; }
  if (trimmedTarget === '') { saveError.value = 'Target model id is required'; return; }

  const rulesOrErr = buildRules();
  if ('error' in rulesOrErr) { saveError.value = rulesOrErr.error; return; }

  const displayNameValue = trimOrUndef(displayName.value);

  saving.value = true;
  try {
    if (mode.value === 'create') {
      const { error } = await callApi(() => api.api.aliases.$post({
        json: {
          alias: trimmedAlias,
          targetModelId: trimmedTarget,
          upstreamIds: [...upstreamIds.value],
          rules: rulesOrErr,
          visibleInModelsList: visibleInModelsList.value,
          onConflict: onConflict.value,
          ...(displayNameValue !== undefined ? { displayName: displayNameValue } : {}),
        },
      }));
      if (error) { saveError.value = error.message; return; }
    } else if (props.record) {
      const { error } = await callApi(() => api.api.aliases[':alias'].$patch({
        param: { alias: props.record!.alias },
        json: {
          targetModelId: trimmedTarget,
          upstreamIds: [...upstreamIds.value],
          rules: rulesOrErr,
          visibleInModelsList: visibleInModelsList.value,
          onConflict: onConflict.value,
          // Carry an explicit null when the operator cleared the label so the
          // backend wipes the display_name column rather than preserving the
          // old value through the absent-field merge.
          displayName: displayNameValue ?? null,
        },
      }));
      if (error) { saveError.value = error.message; return; }
    }
    emit('saved');
    open.value = false;
  } finally {
    saving.value = false;
  }
};

const title = computed(() => mode.value === 'create' ? 'Create Alias' : `Edit Alias: ${props.record?.alias ?? ''}`);

const reasoningModeOptions: { value: ReasoningMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'effort', label: 'Effort preset' },
  { value: 'budget', label: 'Token budget' },
  { value: 'adaptive', label: 'Adaptive' },
];
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="xl">
    <div class="space-y-5">
      <p v-if="saveError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ saveError }}
      </p>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Alias name</label>
          <Input v-model="aliasName" placeholder="codex-auto-review" :disabled="mode === 'edit'" class="font-mono" />
          <p v-if="mode === 'edit'" class="text-xs text-gray-600">Alias names are the primary key and cannot be changed; delete and recreate to rename.</p>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Display name <span class="text-gray-600">(optional)</span></label>
          <Input v-model="displayName" placeholder="Codex Auto Review" />
        </div>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Target model id</label>
        <Input v-model="targetModelId" placeholder="gpt-5.4" class="font-mono" list="alias-model-options" />
        <datalist id="alias-model-options">
          <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </datalist>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Upstreams <span class="text-gray-600">(leave empty to allow any upstream that serves the target)</span></label>
        <TagCombobox v-model="upstreamIds" :items="upstreamItems" placeholder="Pick an upstream..." empty-text="No upstreams match" />
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">On conflict</label>
          <Select v-model="onConflict" :options="onConflictOptions" />
        </div>

        <div class="flex items-center gap-2 pt-6">
          <Checkbox v-model="visibleInModelsList" />
          <label class="text-sm text-gray-300">Visible in <code class="rounded bg-white/[0.04] px-1 font-mono text-xs">/v1/models</code></label>
        </div>
      </div>

      <section class="space-y-3 rounded-md border border-white/[0.06] bg-surface-800/50 p-4">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-400">Reasoning</h4>
        <div class="flex flex-wrap gap-3">
          <label v-for="opt in reasoningModeOptions" :key="opt.value" class="inline-flex items-center gap-2 text-sm text-gray-300">
            <input
              type="radio"
              :value="opt.value"
              :checked="reasoningMode === opt.value"
              :disabled="opt.value === 'adaptive' && !adaptiveSupported && reasoningMode !== 'adaptive'"
              @change="reasoningMode = opt.value"
            >
            {{ opt.label }}
          </label>
        </div>

        <div v-if="reasoningMode === 'effort'" class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Effort</label>
          <Input v-model="reasoningEffort" placeholder="high" list="alias-effort-options" />
          <datalist id="alias-effort-options">
            <option v-for="v in effortSuggestions" :key="v" :value="v" />
          </datalist>
          <p v-if="effortSuggestions.length > 0" class="text-xs text-gray-600">Target supports: {{ effortSuggestions.join(', ') }}</p>
        </div>

        <div v-if="reasoningMode === 'budget'" class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Budget tokens</label>
          <Input v-model="reasoningBudgetTokens" placeholder="4096" inputmode="numeric" class="font-mono" />
          <p v-if="budgetMin !== undefined || budgetMax !== undefined" class="text-xs text-gray-600">
            Target range:
            <template v-if="budgetMin !== undefined">min {{ budgetMin }}</template>
            <template v-if="budgetMin !== undefined && budgetMax !== undefined">, </template>
            <template v-if="budgetMax !== undefined">max {{ budgetMax }}</template>
          </p>
        </div>

        <div v-if="reasoningMode === 'adaptive' && !adaptiveSupported" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          Target model does not advertise adaptive reasoning support. The rule will still be sent verbatim.
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Reasoning summary <span class="text-gray-600">(optional)</span></label>
          <Input v-model="reasoningSummary" placeholder="auto" list="alias-summary-options" />
          <datalist id="alias-summary-options">
            <option v-for="v in SUMMARY_HINTS" :key="v" :value="v" />
          </datalist>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Verbosity</label>
          <Input v-model="verbosity" placeholder="medium" list="alias-verbosity-options" />
          <datalist id="alias-verbosity-options">
            <option v-for="v in VERBOSITY_HINTS" :key="v" :value="v" />
          </datalist>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Service tier</label>
          <Input v-model="serviceTier" placeholder="auto" list="alias-tier-options" />
          <datalist id="alias-tier-options">
            <option v-for="v in SERVICE_TIER_HINTS" :key="v" :value="v" />
          </datalist>
        </div>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Anthropic beta headers <span class="text-gray-600">(comma- or Enter-separated tokens)</span></label>
        <TagCombobox v-model="anthropicBeta" :items="[]" placeholder="extended-cache-ttl-2025-04-11" empty-text="Type a header token and press Enter" />
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-5">
        <Button :loading="saving" @click="save">Save</Button>
        <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
      </div>
    </div>
  </Dialog>
</template>
