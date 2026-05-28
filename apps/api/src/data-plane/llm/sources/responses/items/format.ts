const itemTypePrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  function_call_output: 'fco',
  custom_tool_call: 'ctc',
  custom_tool_call_output: 'ctco',
  file_search_call: 'fs',
  computer_call: 'cc',
  computer_call_output: 'cco',
  tool_search_call: 'ts',
  tool_search_output: 'tso',
  compaction: 'cmp',
  image_generation_call: 'ig',
  code_interpreter_call: 'ci',
  local_shell_call: 'lsh',
  local_shell_call_output: 'lsho',
  shell_call: 'sh',
  shell_call_output: 'sho',
  apply_patch_call: 'ap',
  apply_patch_call_output: 'apo',
  mcp_call: 'mcp',
  mcp_list_tools: 'mcpl',
  mcp_approval_request: 'mcpar',
  mcp_approval_response: 'mcpa',
} as const satisfies Record<string, string>;

const knownPrefixes = new Set<string>(Object.values(itemTypePrefixes));
const bodyPattern = /^[A-Za-z0-9_-]{22}$/;
const checksumPattern = /^[A-Za-z0-9_-]{6}$/;

// Stored ids are `<prefix>_<crc32(body)>_<body>` where `body` is 16 random
// bytes encoded as base64url (22 chars). The body is content-free on purpose:
// uniqueness comes from `crypto.getRandomValues`, and the crc32 prefix lets
// `parseStoredResponsesItemId` reject typos and accidental upstream collisions
// without re-hashing the original item.
export const createStoredResponsesItemId = (itemType: string): string =>
  createChecksummedId(prefixForItemType(itemType), randomBody());

export const parseStoredResponsesItemId = (value: string): { prefix: string; checksum: string; body: string } | null => {
  const firstSeparator = value.indexOf('_');
  if (firstSeparator <= 0) return null;
  const checksumStart = firstSeparator + 1;
  const checksumEnd = checksumStart + 6;
  if (value[checksumEnd] !== '_') return null;

  const prefix = value.slice(0, firstSeparator);
  const checksum = value.slice(checksumStart, checksumEnd);
  const body = value.slice(checksumEnd + 1);

  if (!knownPrefixes.has(prefix)) return null;
  if (!checksumPattern.test(checksum) || !bodyPattern.test(body)) return null;
  if (crc32Checksum(body) !== checksum) return null;
  return { prefix, checksum, body };
};

export const isStoredResponsesItemId = (value: string): boolean => parseStoredResponsesItemId(value) !== null;

export const createTemporaryResponsesItemId = (itemType: string): string => `${prefixForItemType(itemType)}_tmp_${randomBody()}`;

const prefixForItemType = (itemType: string): string => {
  const prefix = itemTypePrefixes[itemType as keyof typeof itemTypePrefixes];
  if (!prefix) throw new TypeError(`Unknown Responses item type: ${itemType}`);
  return prefix;
};

const createChecksummedId = (prefix: string, body: string): string => `${prefix}_${crc32Checksum(body)}_${body}`;

const randomBody = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

const crc32Checksum = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return base64UrlEncode(new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]));
};
