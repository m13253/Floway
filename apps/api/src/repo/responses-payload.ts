import type { StoredResponsesItemPayload } from './types.ts';
import { getFileProvider } from '../runtime/file-provider.ts';

export type StoredResponsesPayloadJson =
  | {
    version: 1;
    storage: 'inline';
    payload: StoredResponsesItemPayload;
  }
  | {
    version: 1;
    storage: 'file';
    key: string;
    sha256: string;
    byteLength: number;
  };

const INLINE_PAYLOAD_LIMIT_BYTES = 512 * 1024;
const PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

export const serializeStoredResponsesPayload = async (
  id: string,
  apiKeyId: string | null,
  createdAt: number,
  payload: StoredResponsesItemPayload | null,
): Promise<string | null> => {
  if (payload === null) return null;

  const inlineJson = JSON.stringify({ version: 1, storage: 'inline', payload } satisfies StoredResponsesPayloadJson);
  if (encoder.encode(inlineJson).byteLength <= INLINE_PAYLOAD_LIMIT_BYTES) return inlineJson;

  const fileBody = encoder.encode(JSON.stringify({ version: 1, ...payload }));
  const key = await storedResponsesPayloadFileKey(id, apiKeyId, createdAt);
  const sha256 = await sha256Hex(fileBody);
  await getFileProvider().put(key, fileBody);
  return JSON.stringify({
    version: 1,
    storage: 'file',
    key,
    sha256,
    byteLength: fileBody.byteLength,
  } satisfies StoredResponsesPayloadJson);
};

export const parseStoredResponsesPayload = async (
  id: string,
  raw: string | null,
): Promise<StoredResponsesItemPayload | null> => {
  if (raw === null) return null;

  const descriptor = parseDescriptor(id, raw);
  if (descriptor.storage === 'inline') return clonePayload(descriptor.payload);

  const body = await getFileProvider().get(descriptor.key);
  if (body === null) throw new Error(`Stored Responses payload file missing for id=${id}`);
  if (body.byteLength !== descriptor.byteLength) {
    throw new Error(`Stored Responses payload file size mismatch for id=${id}`);
  }
  const actualHash = await sha256Hex(body);
  if (actualHash !== descriptor.sha256) {
    throw new Error(`Stored Responses payload file hash mismatch for id=${id}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (cause) {
    throw new Error(`Malformed stored Responses payload file JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  return clonePayload(assertPayloadObject(id, parsed));
};

const parseDescriptor = (id: string, raw: string): StoredResponsesPayloadJson => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Malformed responses_items.payload_json JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  if (!isRecord(parsed) || parsed.version !== 1) throw new Error(`Invalid responses_items.payload_json for id=${id}`);
  if (parsed.storage === 'inline') return { version: 1, storage: 'inline', payload: assertPayloadObject(id, parsed.payload) };
  if (
    parsed.storage === 'file'
    && typeof parsed.key === 'string'
    && typeof parsed.sha256 === 'string'
    && typeof parsed.byteLength === 'number'
    && Number.isSafeInteger(parsed.byteLength)
    && parsed.byteLength >= 0
  ) {
    return { version: 1, storage: 'file', key: parsed.key, sha256: parsed.sha256, byteLength: parsed.byteLength };
  }
  throw new Error(`Invalid responses_items.payload_json for id=${id}`);
};

const assertPayloadObject = (id: string, value: unknown): StoredResponsesItemPayload => {
  if (!isRecord(value) || !Object.hasOwn(value, 'item')) throw new Error(`Invalid stored Responses payload for id=${id}`);
  const payload: StoredResponsesItemPayload = { item: value.item };
  if (Object.hasOwn(value, 'private')) payload.private = value.private;
  return payload;
};

const clonePayload = (payload: StoredResponsesItemPayload): StoredResponsesItemPayload => ({
  ...payload,
  item: structuredClone(payload.item),
  ...(Object.hasOwn(payload, 'private') ? { private: structuredClone(payload.private) } : {}),
});

const storedResponsesPayloadFileKey = async (
  id: string,
  apiKeyId: string | null,
  createdAt: number,
): Promise<string> => {
  const expires = new Date(createdAt + PAYLOAD_TTL_MS);
  const yyyy = String(expires.getUTCFullYear()).padStart(4, '0');
  const mm = String(expires.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(expires.getUTCDate()).padStart(2, '0');
  const hh = String(expires.getUTCHours()).padStart(2, '0');
  const scope = (await sha256Hex(encoder.encode(apiKeyId ?? ''))).slice(0, 16);
  return `responses-items/v1/expires/${yyyy}/${mm}/${dd}/${hh}/${scope}/${id}.json`;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
