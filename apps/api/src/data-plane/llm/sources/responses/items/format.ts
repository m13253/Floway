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

export const isKnownResponsesItemType = (itemType: string): boolean =>
  Object.hasOwn(itemTypePrefixes, itemType);

export const createStoredResponsesItemId = (itemType: string, item: unknown): string => {
  const canonical = canonicalJson(item);
  return createChecksummedId(prefixForItemType(itemType), base64UrlEncode(sha256(new TextEncoder().encode(canonical)).slice(0, 16)));
};

export const createSyntheticStoredResponsesItemId = createStoredResponsesItemId;

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

const canonicalJson = (value: unknown, seen: Set<object> = new Set()): string => {
  if (value === null) return 'null';

  switch (typeof value) {
  case 'string':
  case 'boolean':
    return JSON.stringify(value);
  case 'number':
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
    return JSON.stringify(value);
  case 'object':
    return canonicalObjectJson(value, seen);
  default:
    throw new TypeError(`Cannot canonicalize ${typeof value} as JSON`);
  }
};

const canonicalObjectJson = (value: object, seen: Set<object>): string => {
  if (seen.has(value)) throw new TypeError('Cannot canonicalize cyclic JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, seen)).join(',')}]`;

    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

const sha256Constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256 = (input: Uint8Array): Uint8Array => {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(paddedLength - 4, bitLength, false);

  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + sha256Constants[i] + words[i]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((word, index) => outView.setUint32(index * 4, word, false));
  return out;
};

const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
