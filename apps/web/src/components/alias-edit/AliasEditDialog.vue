<script setup lang="ts">
// Operator editor for one alias. The form is intentionally Goal-2-friendly:
// every "enum" field below is rendered as a combobox with suggestions
// pulled from the target model's chat metadata (when available) and from
// well-known wire values, but the operator can type any value verbatim so
// a new upstream-side level (e.g. an "xhigh" effort that shipped this
// morning) flows through without a frontend release.

import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ModelAlias, ModelAliasOnConflict } from '../../api/types.ts';
import { useModelsStore } from '../../composables/useModels.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { composeAliasDisplayName } from '@floway-dev/protocols/common';
import { Button, Combobox, Dialog, Input, Select, Switch, TagCombobox } from '@floway-dev/ui';

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
  /** null = create; non-null = edit. The alias name is editable in both modes. */
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

// Reasoning fields are flat: every input is always visible. The wire schema
// still allows the four facets (effort / budget / adaptive / summary) to
// coexist; the apply layer's adaptive-first precedence handles the runtime
// resolution. Forcing mutual exclusivity at the UI level previously meant
// operators had to nuke an existing knob before setting another, which
// fought their actual workflow.
const initialReasoning = props.record?.rules.reasoning;
const reasoningEffort = ref(initialReasoning?.effort ?? '');
const reasoningBudgetTokens = ref<string>(initialReasoning?.budgetTokens === undefined ? '' : String(initialReasoning.budgetTokens));
const reasoningAdaptive = ref(initialReasoning?.adaptive === true);
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

const targetMatch = computed(() => modelsStore.models.value?.find(m => m.id === targetModelId.value));

const targetChat = computed(() => {
  const match = targetMatch.value;
  return match && 'chat' in match ? (match as { chat?: { reasoning?: { effort?: { supported: string[] }; budget_tokens?: { min?: number; max?: number }; adaptive?: boolean } } }).chat : undefined;
});

const effortSuggestions = computed(() => targetChat.value?.reasoning?.effort?.supported ?? []);
const budgetMin = computed(() => targetChat.value?.reasoning?.budget_tokens?.min);
const budgetMax = computed(() => targetChat.value?.reasoning?.budget_tokens?.max);
const adaptiveSupported = computed(() => targetChat.value?.reasoning?.adaptive === true);

const SUMMARY_HINTS = ['auto', 'concise', 'detailed', 'omitted'];
const VERBOSITY_HINTS = ['low', 'medium', 'high'];
const SERVICE_TIER_HINTS = ['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'standard_only'];

// Each on-conflict option carries a one-line explanation surfaced both in
// the Select popover and in a helper line below the trigger so an operator
// picks by what happens at request time, not by guessing what `real-only`
// / `alias-only` mean. Mirrors the Auth Style pattern in CustomConfigPanel.
interface OnConflictOption {
  value: ModelAliasOnConflict;
  label: string;
  explanation: string;
}

const onConflictOptions: OnConflictOption[] = [
  {
    value: 'real-only',
    label: 'Real model wins',
    explanation: "When an upstream serves a real model with the same id as this alias, the real model is used and the alias's rules don't apply on that upstream.",
  },
  {
    value: 'alias-only',
    label: 'Alias replaces real',
    explanation: 'The alias always wins, even when an upstream serves a real model with the same id.',
  },
  {
    value: 'both-real-first',
    label: 'Both, real first',
    explanation: 'Both entries appear; routing prefers the real model when present, falling back to the alias.',
  },
  {
    value: 'both-alias-first',
    label: 'Both, alias first',
    explanation: 'Both entries appear; routing prefers the alias when present, falling back to the real model.',
  },
];

const selectedOnConflict = computed(() => onConflictOptions.find(o => o.value === onConflict.value));

// --- display name placeholder ---
//
// Shows the operator what the synthesized fallback would look like when
// the Display name field is left blank. Before a target is picked we hold
// a teaching example so the three placeholders (alias / target / display
// name) read as a coherent trio; once a target is set we compute the real
// synthesized label off the current form state so the placeholder tracks
// every rule edit live.
const FALLBACK_PLACEHOLDER_EXAMPLE = 'GPT-5.5 (xhigh effort, fast speed)';

// Mirror of `buildRules` without the validation errors — used purely for
// the live placeholder so a half-typed budget value (e.g. mid-typing) does
// not bubble validation text into a UI hint. Invalid intermediate states
// fall back to the empty rules object.
const buildRulesForPreview = (): MutableRules => {
  const rules: MutableRules = {};
  const reasoning: NonNullable<MutableRules['reasoning']> = {};
  const effort = reasoningEffort.value.trim();
  if (effort !== '') reasoning.effort = effort;
  const budgetRaw = reasoningBudgetTokens.value.trim();
  if (budgetRaw !== '' && /^\d+$/.test(budgetRaw)) reasoning.budgetTokens = Number(budgetRaw);
  if (reasoningAdaptive.value) reasoning.adaptive = true;
  const summary = reasoningSummary.value.trim();
  if (summary !== '') reasoning.summary = summary;
  if (Object.keys(reasoning).length > 0) rules.reasoning = reasoning;
  const verb = verbosity.value.trim();
  if (verb !== '') rules.verbosity = verb;
  const tier = serviceTier.value.trim();
  if (tier !== '') rules.serviceTier = tier;
  const betas = anthropicBeta.value.map(s => s.trim()).filter(s => s !== '');
  if (betas.length > 0) rules.anthropicBeta = betas;
  return rules;
};

const displayNamePlaceholder = computed(() => {
  const trimmedTarget = targetModelId.value.trim();
  if (trimmedTarget === '') return FALLBACK_PLACEHOLDER_EXAMPLE;
  const targetDisplay = targetMatch.value?.display_name ?? trimmedTarget;
  return composeAliasDisplayName({
    targetDisplayName: targetDisplay,
    rules: buildRulesForPreview(),
  });
});

// --- save ---

const saving = ref(false);
const saveError = ref<string | null>(null);

const trimOrUndef = (s: string): string | undefined => {
  const t = s.trim();
  return t === '' ? undefined : t;
};

const buildRules = (): MutableRules | { error: string } => {
  const rules: MutableRules = {};
  const reasoning: NonNullable<MutableRules['reasoning']> = {};

  const effort = trimOrUndef(reasoningEffort.value);
  if (effort !== undefined) reasoning.effort = effort;

  const budgetRaw = reasoningBudgetTokens.value.trim();
  if (budgetRaw !== '') {
    if (!/^\d+$/.test(budgetRaw)) return { error: 'Reasoning budget tokens must be a non-negative integer' };
    reasoning.budgetTokens = Number(budgetRaw);
  }

  if (reasoningAdaptive.value) reasoning.adaptive = true;

  const summary = trimOrUndef(reasoningSummary.value);
  if (summary !== undefined) reasoning.summary = summary;

  if (Object.keys(reasoning).length > 0) rules.reasoning = reasoning;

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
  if (trimmedAlias === '') { saveError.value = 'Alias name is required'; return; }
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
      // PATCH addresses the row at its *original* PK; `alias` in the body
      // requests a rename when it differs. The backend route handles the
      // 409-on-collision path and the safe no-op when nothing changed.
      const { error } = await callApi(() => api.api.aliases[':alias'].$patch({
        param: { alias: props.record!.alias },
        json: {
          alias: trimmedAlias,
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
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="xl">
    <div class="space-y-5">
      <p v-if="saveError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ saveError }}
      </p>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Alias name</label>
          <Input v-model="aliasName" placeholder="gpt-5.5-xhigh-fast" class="font-mono" />
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Target model id</label>
          <Combobox v-model="targetModelId" :items="modelOptions" placeholder="gpt-5.5" input-class="font-mono" />
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Display name <span class="text-gray-600">(optional)</span></label>
        <Input v-model="displayName" :placeholder="displayNamePlaceholder" />
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Upstreams <span class="text-gray-600">(leave empty to allow any upstream that serves the target)</span></label>
        <TagCombobox v-model="upstreamIds" :items="upstreamItems" placeholder="Pick an upstream..." empty-text="No upstreams match" />
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">On conflict</label>
        <Select v-model="onConflict" :options="onConflictOptions">
          <template #description="{ option }">
            <p class="text-[11px] text-gray-500">{{ option.explanation }}</p>
          </template>
        </Select>
        <p v-if="selectedOnConflict" class="mt-1.5 text-xs text-gray-500">{{ selectedOnConflict.explanation }}</p>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Effort</label>
          <Combobox v-model="reasoningEffort" :items="effortSuggestions" placeholder="high" />
          <p v-if="effortSuggestions.length > 0" class="mt-1 text-xs text-gray-600">Target supports: {{ effortSuggestions.join(', ') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Budget tokens</label>
          <Input
            v-model="reasoningBudgetTokens"
            placeholder="4096"
            inputmode="numeric"
            class="font-mono"
            :min="budgetMin"
            :max="budgetMax"
          />
          <p v-if="budgetMin !== undefined || budgetMax !== undefined" class="mt-1 text-xs text-gray-600">
            Target range:
            <template v-if="budgetMin !== undefined">min {{ budgetMin }}</template>
            <template v-if="budgetMin !== undefined && budgetMax !== undefined">, </template>
            <template v-if="budgetMax !== undefined">max {{ budgetMax }}</template>
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div class="flex h-9 items-center gap-2">
            <Switch v-model="reasoningAdaptive" />
            <span class="text-sm text-gray-300">Adaptive reasoning</span>
          </div>
          <p v-if="reasoningAdaptive && !adaptiveSupported" class="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
            Target model does not advertise adaptive reasoning support. The rule will still be sent verbatim.
          </p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Summary</label>
          <Combobox v-model="reasoningSummary" :items="SUMMARY_HINTS" placeholder="auto" />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Verbosity</label>
          <Combobox v-model="verbosity" :items="VERBOSITY_HINTS" placeholder="medium" />
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Service tier</label>
          <Combobox v-model="serviceTier" :items="SERVICE_TIER_HINTS" placeholder="auto" />
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Anthropic beta headers <span class="text-gray-600">(comma- or Enter-separated tokens)</span></label>
        <TagCombobox v-model="anthropicBeta" :items="[]" placeholder="extended-cache-ttl-2025-04-11" empty-text="Type a header token and press Enter" />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
        <label class="flex items-center gap-2">
          <Switch v-model="visibleInModelsList" />
          <span class="text-sm text-gray-300">Visible in <code class="rounded bg-white/[0.04] px-1 font-mono text-xs">/v1/models</code></span>
        </label>
        <div class="flex items-center gap-2">
          <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
          <Button :loading="saving" @click="save">Save</Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
