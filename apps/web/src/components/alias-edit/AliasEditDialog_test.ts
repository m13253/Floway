// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import type { ModelAlias } from '../../api/types.ts';

// Module-level mocks for the api client + every store the dialog imports.
// The dialog stays as-is; we substitute the dependencies so the component
// renders and submits without any real HTTP. callApi is exposed as a spy so
// tests can read what was posted.
const createAliasMock = vi.fn(async (_args: { json: unknown }) => new Response(JSON.stringify({}), { status: 201, headers: { 'content-type': 'application/json' } }));
const patchAliasMock = vi.fn(async (_args: { param: { alias: string }; json: unknown }) => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));

vi.mock('../../api/client.ts', async () => {
  const { callApi: realCallApi } = await vi.importActual<typeof import('../../api/client.ts')>('../../api/client.ts');
  return {
    useApi: () => ({
      api: {
        aliases: Object.assign(
          { $post: (args: { json: unknown }) => createAliasMock(args) },
          { ':alias': { $patch: (args: { param: { alias: string }; json: unknown }) => patchAliasMock(args) } },
        ),
      },
    }),
    callApi: realCallApi,
  };
});

vi.mock('../../composables/useModels.ts', () => ({
  useModelsStore: () => ({
    models: {
      value: [
        { id: 'gpt-5.4', display_name: 'GPT-5.4', object: 'model', type: 'model', limits: {}, kind: 'chat', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' }, budget_tokens: { min: 1024, max: 8192 }, adaptive: true } } },
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', object: 'model', type: 'model', limits: {}, kind: 'chat' },
      ],
    },
    loading: { value: false },
    error: { value: null },
    load: vi.fn(async () => undefined),
  }),
}));

vi.mock('../../composables/useUpstreams.ts', () => ({
  useUpstreamsStore: () => ({
    upstreams: {
      value: [
        { id: 'up_oai', name: 'OpenAI' },
        { id: 'up_anth', name: 'Anthropic' },
      ],
    },
    loading: { value: false },
    load: vi.fn(async () => undefined),
  }),
}));

// reka-ui's Dialog mounts via Teleport into document.body and renders a
// portal — we stub it down to a passthrough so happy-dom mounts the slot
// content inline where assertions can reach it.
vi.mock('@floway-dev/ui', async () => {
  const real = await vi.importActual<typeof import('@floway-dev/ui')>('@floway-dev/ui');
  const Passthrough = defineComponent({ name: 'Passthrough', setup(_props, { slots }) { return () => h('div', slots.default?.()); } });
  return { ...real, Dialog: Passthrough };
});

beforeEach(() => {
  createAliasMock.mockClear();
  patchAliasMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

test('AliasEditDialog (create mode) posts a payload matching the form state', async () => {
  const { default: AliasEditDialog } = await import('./AliasEditDialog.vue');
  const open = ref(true);

  const wrapper = mount(defineComponent({
    components: { AliasEditDialog },
    setup() { return { open }; },
    template: '<AliasEditDialog v-model:open="open" :record="null" />',
  }));

  // Fill the form: alias name + target id are the only required fields for
  // the create-mode happy path. Everything else uses its default.
  const aliasInput = wrapper.find('input[placeholder="gpt-5.5-xhigh-fast"]');
  expect(aliasInput.exists()).toBe(true);
  await aliasInput.setValue('opus-fast');

  const targetInput = wrapper.find('input[placeholder="gpt-5.5"]');
  expect(targetInput.exists()).toBe(true);
  await targetInput.setValue('claude-opus-4-6');

  // Click Save.
  const saveBtn = wrapper.findAll('button').find(b => b.text() === 'Save');
  expect(saveBtn).toBeDefined();
  await saveBtn!.trigger('click');
  // Flush microtasks so the async save completes.
  await new Promise(r => setTimeout(r, 0));

  expect(createAliasMock).toHaveBeenCalledTimes(1);
  const args = createAliasMock.mock.calls[0]![0];
  expect(args.json).toMatchObject({
    alias: 'opus-fast',
    targetModelId: 'claude-opus-4-6',
    upstreamIds: [],
    rules: {},
    visibleInModelsList: true,
    onConflict: 'real-only',
  });
});

test('AliasEditDialog (edit mode) pre-fills the form and PATCHes the merged shape', async () => {
  const { default: AliasEditDialog } = await import('./AliasEditDialog.vue');
  const open = ref(true);
  const record: ModelAlias = {
    alias: 'opus-xhigh',
    target_model_id: 'claude-opus-4-6',
    upstream_ids: ['up_anth'],
    rules: { reasoning: { effort: 'xhigh' } },
    visible_in_models_list: true,
    on_conflict: 'real-only',
    display_name: 'Opus XHigh',
    created_at: 1_700_000_000,
  };

  const wrapper = mount(defineComponent({
    components: { AliasEditDialog },
    setup() { return { open, record }; },
    template: '<AliasEditDialog v-model:open="open" :record="record" />',
  }));

  // Alias name input is editable in edit mode — the PK can now be renamed.
  const aliasInput = wrapper.find('input[placeholder="gpt-5.5-xhigh-fast"]');
  expect(aliasInput.exists()).toBe(true);
  expect((aliasInput.element as HTMLInputElement).disabled).toBe(false);
  expect((aliasInput.element as HTMLInputElement).value).toBe('opus-xhigh');

  // Display name pre-filled — its placeholder is dynamic now (mirrors the
  // synthesized fallback) so we locate it by its current value instead.
  const allInputs = wrapper.findAll('input');
  const displayInput = allInputs.find(i => (i.element as HTMLInputElement).value === 'Opus XHigh');
  expect(displayInput).toBeDefined();

  // Target id pre-filled.
  const targetInput = wrapper.find('input[placeholder="gpt-5.5"]');
  expect((targetInput.element as HTMLInputElement).value).toBe('claude-opus-4-6');

  // Change one field and submit; PATCH carries the merged shape (every editable
  // field, not just the diff — the route layer merges against the stored row).
  await targetInput.setValue('gpt-5.4');
  const saveBtn = wrapper.findAll('button').find(b => b.text() === 'Save');
  await saveBtn!.trigger('click');
  await new Promise(r => setTimeout(r, 0));

  expect(patchAliasMock).toHaveBeenCalledTimes(1);
  const args = patchAliasMock.mock.calls[0]![0];
  expect(args.param.alias).toBe('opus-xhigh');
  expect(args.json).toMatchObject({
    alias: 'opus-xhigh',
    targetModelId: 'gpt-5.4',
    upstreamIds: ['up_anth'],
    rules: { reasoning: { effort: 'xhigh' } },
    visibleInModelsList: true,
    onConflict: 'real-only',
    displayName: 'Opus XHigh',
  });
});

test('AliasEditDialog (edit mode) PATCHes the original alias when the operator renames it', async () => {
  const { default: AliasEditDialog } = await import('./AliasEditDialog.vue');
  const open = ref(true);
  const record: ModelAlias = {
    alias: 'opus-xhigh',
    target_model_id: 'claude-opus-4-6',
    upstream_ids: [],
    rules: {},
    visible_in_models_list: true,
    on_conflict: 'real-only',
    display_name: null,
    created_at: 1_700_000_000,
  };

  const wrapper = mount(defineComponent({
    components: { AliasEditDialog },
    setup() { return { open, record }; },
    template: '<AliasEditDialog v-model:open="open" :record="record" />',
  }));

  const aliasInput = wrapper.find('input[placeholder="gpt-5.5-xhigh-fast"]');
  await aliasInput.setValue('opus-renamed');

  const saveBtn = wrapper.findAll('button').find(b => b.text() === 'Save');
  await saveBtn!.trigger('click');
  await new Promise(r => setTimeout(r, 0));

  expect(patchAliasMock).toHaveBeenCalledTimes(1);
  const args = patchAliasMock.mock.calls[0]![0];
  // The PATCH path stays at the row's *original* PK; the rename is requested
  // via `body.alias`, which the route handler maps to the rename codepath.
  expect(args.param.alias).toBe('opus-xhigh');
  expect(args.json).toMatchObject({ alias: 'opus-renamed' });
});
