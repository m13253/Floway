<script setup lang="ts">
// Editor for one alias (create or edit). Top form (name / display name /
// kind / selection); a vertical stack of AliasTargetRow cards with an
// "Add target" button; alias-level warnings card; footer (visibility
// switch + Cancel / Save).

import { computed, ref } from 'vue';

import AliasTargetRow from './AliasTargetRow.vue';
import { computeShadowWarning, realModelIds } from './warnings.ts';
import { callApi, useApi } from '../../api/client.ts';
import type { AliasKind, AliasSelection, AliasTarget, ChatAliasRules, ModelAlias } from '../../api/types.ts';
import { useModelAliases } from '../../composables/useModelAliases.ts';
import { useModelsStore } from '../../composables/useModels.ts';
import { Button, Dialog, Input, Select, Switch } from '@floway-dev/ui';

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
  /** null = create; non-null = edit. */
  record: ModelAlias | null;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();
const aliasesStore = useModelAliases();
const modelsStore = useModelsStore();

const mode = computed<'create' | 'edit'>(() => (props.record ? 'edit' : 'create'));

// Switching kind discards rule state — a chat-only rule must not survive a
// switch into embedding/image.
const emptyRulesFor = (k: AliasKind): AliasTarget['rules'] => (k === 'chat' ? {} as ChatAliasRules : {} as Record<string, never>);

const blankTarget = (k: AliasKind): AliasTarget => ({ target_model_id: '', rules: emptyRulesFor(k) });

const aliasName = ref(props.record?.name ?? '');
const displayName = ref(props.record?.display_name ?? '');
const kind = ref<AliasKind>(props.record?.kind ?? 'chat');
const selection = ref<AliasSelection>(props.record?.selection ?? 'first-available');
const visibleInModelsList = ref(props.record?.visible_in_models_list ?? true);

// Create mode starts with one blank target so the operator immediately sees
// a row to fill in.
const targets = ref<AliasTarget[]>(
  props.record
    ? props.record.targets.map(t => ({ target_model_id: t.target_model_id, rules: { ...t.rules } as AliasTarget['rules'] }))
    : [blankTarget(kind.value)],
);

const setKind = (k: AliasKind) => {
  kind.value = k;
  targets.value = targets.value.map(t => ({ target_model_id: t.target_model_id, rules: emptyRulesFor(k) }));
};

const addTarget = () => { targets.value = [...targets.value, blankTarget(kind.value)]; };

const updateTarget = (idx: number, next: AliasTarget) => {
  const copy = targets.value.slice();
  copy[idx] = next;
  targets.value = copy;
};

const moveTarget = (idx: number, delta: -1 | 1) => {
  const j = idx + delta;
  if (j < 0 || j >= targets.value.length) return;
  const copy = targets.value.slice();
  [copy[idx], copy[j]] = [copy[j], copy[idx]];
  targets.value = copy;
};

const removeTarget = (idx: number) => {
  if (targets.value.length <= 1) return;
  targets.value = targets.value.filter((_, i) => i !== idx);
};

// Suggestion list for every target-id combobox. Aliases are excluded so an
// operator can't accidentally hop into the alias layer twice.
const targetIdItems = computed(() => realModelIds(modelsStore.models.value));

const shadowWarning = computed(() => computeShadowWarning(aliasName.value.trim(), targets.value, modelsStore.models.value));

const saving = ref(false);
const saveError = ref<string | null>(null);

// Save gate: name non-empty AND no collision with another alias AND ≥1
// target AND every target id non-empty. The collision check excludes the
// current record so an in-place edit of an unchanged name is allowed.
const validationError = computed<string | null>(() => {
  const trimmed = aliasName.value.trim();
  if (trimmed === '') return 'Alias name is required';
  const collisions = (aliasesStore.aliases.value ?? []).filter(a => a.name === trimmed && a.name !== props.record?.name);
  if (collisions.length > 0) return `An alias named "${trimmed}" already exists`;
  if (targets.value.length === 0) return 'At least one target is required';
  if (targets.value.some(t => t.target_model_id.trim() === '')) return 'Every target needs a model id';
  return null;
});

const canSave = computed(() => validationError.value === null && !saving.value);

const save = async () => {
  saveError.value = validationError.value;
  if (saveError.value !== null) return;

  const trimmedName = aliasName.value.trim();
  const trimmedDisplay = displayName.value.trim();
  // The Hono RPC body type infers each target's `rules` as the loose
  // `Record<string, unknown>` from the Zod schema, so build the payload
  // with that loose shape and cast each target's rules to match.
  const body = {
    name: trimmedName,
    kind: kind.value,
    selection: selection.value,
    display_name: trimmedDisplay === '' ? null : trimmedDisplay,
    visible_in_models_list: visibleInModelsList.value,
    targets: targets.value.map(t => ({
      target_model_id: t.target_model_id.trim(),
      rules: t.rules as Record<string, unknown>,
    })),
    sort_order: props.record?.sort_order ?? 0,
  };

  saving.value = true;
  try {
    if (mode.value === 'create') {
      const { error } = await callApi(() => api.api.aliases.$post({ json: body }));
      if (error) { saveError.value = error.message; return; }
    } else if (props.record) {
      const { error } = await callApi(() => api.api.aliases[':name'].$put({
        param: { name: props.record.name },
        json: body,
      }));
      if (error) { saveError.value = error.message; return; }
    }
    emit('saved');
    open.value = false;
  } finally {
    saving.value = false;
  }
};

const title = computed(() => mode.value === 'create' ? 'Create Alias' : `Edit Alias: ${props.record?.name ?? ''}`);

const KIND_OPTIONS: { value: AliasKind; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
];
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
          <Input v-model="aliasName" placeholder="my-alias-id" class="font-mono" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Display name</label>
          <Input v-model="displayName" placeholder="auto" />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Kind</label>
          <Select :model-value="kind" :options="KIND_OPTIONS" @update:model-value="v => setKind(v as AliasKind)" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Selection</label>
          <div class="inline-flex h-9 items-center overflow-hidden rounded-[10px] border border-white/[0.14] bg-surface-700 text-xs">
            <button
              type="button"
              class="px-3 py-1.5 transition-colors"
              :class="selection === 'first-available' ? 'bg-accent-cyan/20 text-accent-cyan' : 'text-gray-400 hover:text-gray-200'"
              @click="selection = 'first-available'"
            >First available</button>
            <button
              type="button"
              class="px-3 py-1.5 transition-colors"
              :class="selection === 'random' ? 'bg-accent-cyan/20 text-accent-cyan' : 'text-gray-400 hover:text-gray-200'"
              @click="selection = 'random'"
            >Random</button>
          </div>
        </div>
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Models</h4>
          <Button variant="secondary" size="sm" @click="addTarget">Add target</Button>
        </div>
        <div class="space-y-2">
          <AliasTargetRow
            v-for="(t, idx) in targets"
            :key="idx"
            :model-value="t"
            :kind="kind"
            :target-id-items="targetIdItems"
            :models="modelsStore.models.value"
            :is-first="idx === 0"
            :is-last="idx === targets.length - 1"
            :is-sole="targets.length === 1"
            @update:model-value="(next: AliasTarget) => updateTarget(idx, next)"
            @move-up="moveTarget(idx, -1)"
            @move-down="moveTarget(idx, 1)"
            @remove="removeTarget(idx)"
          />
        </div>
      </div>

      <div v-if="shadowWarning" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
        This alias name shadows a real model id:
        <code class="font-mono">{{ shadowWarning.shadowedId }}</code>
        <template v-if="shadowWarning.shadowedDisplayName !== null">
          (<strong class="font-semibold">{{ shadowWarning.shadowedDisplayName }}</strong>).
        </template>
        <template v-else>.</template>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
        <label class="flex items-center gap-2">
          <Switch v-model="visibleInModelsList" />
          <span class="text-sm text-gray-300">Visible in <code class="rounded bg-white/[0.04] px-1 font-mono text-xs">/v1/models</code></span>
        </label>
        <div class="flex items-center gap-2">
          <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
          <Button :loading="saving" :disabled="!canSave" @click="save">Save</Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
