import { test } from 'vitest';

import {
  createStoredResponsesItemId,
  createSyntheticStoredResponsesItemId,
  createTemporaryResponsesItemId,
  isStoredResponsesItemId,
  parseStoredResponsesItemId,
} from './format.ts';
import { assert, assertEquals, assertFalse, assertThrows } from '../../../../../test-assert.ts';

const explicitPrefixes = [
  ['message', 'msg'],
  ['reasoning', 'rs'],
  ['web_search_call', 'ws'],
  ['function_call', 'fc'],
  ['function_call_output', 'fco'],
  ['custom_tool_call', 'ctc'],
  ['custom_tool_call_output', 'ctco'],
  ['file_search_call', 'fs'],
  ['computer_call', 'cc'],
  ['computer_call_output', 'cco'],
  ['tool_search_call', 'ts'],
  ['tool_search_output', 'tso'],
  ['compaction', 'cmp'],
  ['image_generation_call', 'ig'],
  ['code_interpreter_call', 'ci'],
  ['local_shell_call', 'lsh'],
  ['local_shell_call_output', 'lsho'],
  ['shell_call', 'sh'],
  ['shell_call_output', 'sho'],
  ['apply_patch_call', 'ap'],
  ['apply_patch_call_output', 'apo'],
  ['mcp_call', 'mcp'],
  ['mcp_list_tools', 'mcpl'],
  ['mcp_approval_request', 'mcpar'],
  ['mcp_approval_response', 'mcpa'],
] as const;

test('parses the design-spec examples with CRC32 over only the body segment', () => {
  assertEquals(parseStoredResponsesItemId('msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA'), {
    prefix: 'msg',
    checksum: 'z1mVjw',
    body: '0xVvS8c_KjD1sBkZk5qbdA',
  });
  assertEquals(parseStoredResponsesItemId('rs_mFBDiA_Lh1uXb7nD_bQb4I1CUYH2w'), {
    prefix: 'rs',
    checksum: 'mFBDiA',
    body: 'Lh1uXb7nD_bQb4I1CUYH2w',
  });
  assertEquals(parseStoredResponsesItemId('ws_WGRXTA_sVlhxg6BAV0BUzj0KkWSqA'), {
    prefix: 'ws',
    checksum: 'WGRXTA',
    body: 'sVlhxg6BAV0BUzj0KkWSqA',
  });
});

test('rejects malformed public ids before D1 lookup', () => {
  assertFalse(isStoredResponsesItemId('msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA'));
  assertEquals(parseStoredResponsesItemId('msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA'), null);
  assertEquals(parseStoredResponsesItemId('itm_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA'), null);
  assertEquals(parseStoredResponsesItemId('msg_z1mVjw_short'), null);
  assertEquals(parseStoredResponsesItemId('msg_z1mVjw_0xVvS8c.KjD1sBkZk5qbdA'), null);
});

test('generates a valid stored id for every explicit supported item type', () => {
  for (const [itemType, prefix] of explicitPrefixes) {
    const id = createStoredResponsesItemId(itemType, { type: itemType, id: `${prefix}_source` });
    const parsed = parseStoredResponsesItemId(id);
    assert(parsed, `expected ${id} to parse`);
    assertEquals(parsed.prefix, prefix);
    assertEquals(parsed.body.length, 22);
    assertEquals(parsed.checksum.length, 6);
  }
});

test('throws for unknown item types instead of using a generic fallback prefix', () => {
  assertThrows(() => createStoredResponsesItemId('unknown_item', { type: 'unknown_item' }), TypeError, 'Unknown Responses item type');
  assertThrows(() => createSyntheticStoredResponsesItemId('unknown_item', { type: 'unknown_item' }), TypeError, 'Unknown Responses item type');
  assertThrows(() => createTemporaryResponsesItemId('unknown_item'), TypeError, 'Unknown Responses item type');
});

test('stored ids use stable sorted-key object hashing including the item id', () => {
  const first = createStoredResponsesItemId('web_search_call', {
    type: 'web_search_call',
    id: 'ws_original',
    status: 'completed',
    action: {
      query: 'weather',
      filters: { b: 2, a: 1 },
    },
  });
  const same = createStoredResponsesItemId('web_search_call', {
    action: {
      filters: { a: 1, b: 2 },
      query: 'weather',
    },
    id: 'ws_original',
    status: 'completed',
    type: 'web_search_call',
  });
  const differentContent = createStoredResponsesItemId('web_search_call', {
    type: 'web_search_call',
    id: 'ws_original',
    status: 'completed',
    action: {
      query: 'news',
      filters: { a: 1, b: 2 },
    },
  });
  const differentId = createStoredResponsesItemId('web_search_call', {
    type: 'web_search_call',
    id: 'ws_other',
    status: 'completed',
    action: {
      query: 'weather',
      filters: { a: 1, b: 2 },
    },
  });

  assertEquals(first, same);
  assert(first !== differentContent);
  assert(first !== differentId);
  assertEquals(parseStoredResponsesItemId(first)?.prefix, 'ws');
});

test('synthetic helper is the same object-hash id function', () => {
  const item = { type: 'message', id: 'msg_synthetic', role: 'assistant', content: [] };
  assertEquals(createSyntheticStoredResponsesItemId('message', item), createStoredResponsesItemId('message', item));
});

test('temporary ids use the item prefix without becoming stored ids', () => {
  const temporary = createTemporaryResponsesItemId('reasoning');
  assert(/^rs_tmp_[A-Za-z0-9_-]{22}$/.test(temporary), temporary);
  assertFalse(isStoredResponsesItemId(temporary));
});
