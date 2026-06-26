import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import type { ChatAliasRules, ControlPlaneModel, ModelAlias } from '../../api/types.ts';

// Mock the API client + composables so the dialog mounts without hitting the
// network. The composables expose `ref`-based state — return the same shape
// so the dialog reads the catalog and the alias list directly off these
// stubs.
const aliasesRef = ref<ModelAlias[]>([]);
const modelsRef = ref<ControlPlaneModel[]>([]);
const postSpy = vi.fn(async (_arg: unknown) => new Response(JSON.stringify({}), { status: 201 }));
const putSpy = vi.fn(async (_arg: unknown) => new Response(JSON.stringify({}), { status: 200 }));

vi.mock('../../composables/useModelAliases.ts', () => ({
  useModelAliases: () => ({ aliases: aliasesRef, loading: ref(false), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../composables/useModels.ts', () => ({
  useRawModelsStore: () => ({ models: modelsRef, loading: ref(false), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../api/client.ts', () => ({
  useApi: () => ({
    api: {
      aliases: {
        $post: (arg: unknown) => postSpy(arg),
        ':name': { $put: (arg: unknown) => putSpy(arg) },
      },
    },
  }),
  callApi: async <T>(fn: () => Promise<Response>) => {
    const res = await fn();
    if (!res.ok) return { error: { status: res.status, message: 'mock-error' } };
    return { data: (await res.json()) as T };
  },
  authFetch: vi.fn(),
}));

// Import after mocks are registered.
const { default: AliasEditDialog } = await import('./AliasEditDialog.vue');

const realModel = (id: string, display?: string): ControlPlaneModel => ({
  id,
  display_name: display,
  upstreams: [{ id: 'u1', name: 'U1', kind: 'custom' }],
});

const baseAlias = (over: Partial<ModelAlias> & { name: string }): ModelAlias => ({
  kind: 'chat',
  selection: 'first-available',
  display_name: null,
  visible_in_models_list: true,
  targets: [{ target_model_id: 'gpt-5', rules: {} as ChatAliasRules }],
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

// Reka-UI's DialogPortal teleports content out of the wrapper. Read the
// portal-rooted DOM by scanning document.body directly.
const portalText = () => document.body.textContent ?? '';
const portalQuery = <T extends Element>(selector: string): T | null => document.body.querySelector<T>(selector);
const portalQueryAll = <T extends Element>(selector: string): T[] => Array.from(document.body.querySelectorAll<T>(selector));

beforeEach(() => {
  aliasesRef.value = [];
  modelsRef.value = [realModel('gpt-5', 'GPT 5'), realModel('claude')];
  postSpy.mockClear();
  putSpy.mockClear();
});

afterEach(() => {
  // Reka-UI portals append to document.body; clear them between tests so
  // subsequent assertions don't see stale content.
  document.body.innerHTML = '';
});

describe('AliasEditDialog', () => {
  it('starts create mode with one blank target row and seeds the form fields', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(1);
    const inputs = portalQueryAll<HTMLInputElement>('input[type="text"]');
    expect(inputs[0].value).toBe('');
    w.unmount();
  });

  it('"Add target" appends a row', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(1);
    const addBtn = portalQueryAll<HTMLButtonElement>('button').find(b => b.textContent?.trim() === 'Add target')!;
    addBtn.click();
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(2);
    w.unmount();
  });

  it('expands the chat rule body for chat aliases; the row toggle is disabled for non-chat aliases', async () => {
    const chat = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'a', targets: [{ target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } as ChatAliasRules }] }) },
      attachTo: document.body,
    });
    await nextTick();
    portalQuery<HTMLButtonElement>('button[aria-label="Toggle target row"]')!.click();
    await nextTick();
    expect(portalText()).toContain('Reasoning effort');
    chat.unmount();
    document.body.innerHTML = '';

    const embed = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'e', kind: 'embedding', targets: [{ target_model_id: 'embed-1', rules: {} as never }] }) },
      attachTo: document.body,
    });
    await nextTick();
    const toggle = portalQuery<HTMLButtonElement>('button[aria-label="Toggle target row"]')!;
    expect(toggle.disabled).toBe(true);
    expect(portalText()).not.toContain('Reasoning effort');
    embed.unmount();
  });

  it('Save is disabled on empty name and on collision with another alias; enabled once the name is unique', async () => {
    aliasesRef.value = [baseAlias({ name: 'existing' })];
    // Seed the edit dialog with a valid target so the only validation knob
    // under test is the alias name (the borderless combobox in the target
    // row doesn't surface a plain HTMLInput we can drive from the test).
    const w = mount(AliasEditDialog, {
      props: {
        open: true,
        record: baseAlias({ name: '', targets: [{ target_model_id: 'gpt-5', rules: {} as ChatAliasRules }] }),
      },
      attachTo: document.body,
    });
    await nextTick();

    const saveBtn = portalQueryAll<HTMLButtonElement>('button').find(b => b.textContent?.trim() === 'Save')!;
    expect(saveBtn.disabled).toBe(true);

    const nameInput = portalQueryAll<HTMLInputElement>('input[type="text"]')[0];
    nameInput.value = 'existing';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(saveBtn.disabled).toBe(true);

    nameInput.value = 'fresh';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(saveBtn.disabled).toBe(false);

    w.unmount();
  });

  it('renders the shadow warning card when the alias name collides with a real model and no target references it', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();

    const nameInput = portalQueryAll<HTMLInputElement>('input[type="text"]')[0];
    nameInput.value = 'gpt-5';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(portalText()).toContain('shadows a real model id');
    expect(document.body.innerHTML).toContain('<strong class="font-semibold">GPT 5</strong>');
    w.unmount();
  });
});
