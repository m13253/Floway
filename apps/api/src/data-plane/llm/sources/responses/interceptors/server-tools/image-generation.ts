import { resolveModelForRequest } from '../../../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../../../providers/types.ts';
import { recordTokenUsageForApiKey, tokenUsageFromImagesResponse } from '../../../../../shared/telemetry/usage.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../interceptors.ts';
import { serverToolResultSlot } from '../server-tool-shim.ts';
import type { ServerToolLifecycleEvent, ServerToolOutputItem, ServerToolRegistration } from '../server-tool-shim.ts';
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionTool,
  ResponseFunctionToolCallItem,
  ResponseHostedTool,
  ResponseInputImageGenerationCall,
  ResponseInputItem,
  ResponseOutputImageGenerationCall,
  ResponseTool,
} from '@floway-dev/protocols/responses';

export const SHIM_TOOL_NAME = 'image_generation';

// Default image backend when the hosted tool omits `model`. gpt-image-2 is
// the reference backend Azure's native Responses `image_generation` routes
// to; operators provision it under this public id (or alias it).
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

// Safety valve on the multi-turn ReAct loop: cap how many turns may dispatch
// an image backend call within a single response. Past the cap the dispatcher
// replays an exhausted-budget tool output instead of hitting the backend, so a
// model that keeps retrying after failures cannot drive unbounded image cost.
const IMAGE_ITERATION_CAP = 10;

// Public Responses `image_generation` tool config enums (Azure-strict
// surface). `webp` and arbitrary `WxH` sizes are rejected because the
// native Azure path rejects them; the shim mirrors that vocabulary rather
// than passing them to a backend that would 400 with a different shape.
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpeg']);
const ALLOWED_MODERATIONS = new Set(['auto', 'low']);
const ALLOWED_ACTIONS = new Set(['generate', 'edit', 'auto']);
const ALLOWED_INPUT_FIDELITY = new Set(['high', 'low']);

// The public `image_generation` tool-config surface. Azure rejects any other
// field with `unknown_parameter`, so the shim mirrors that strictness rather
// than silently forwarding unknown fields (which would diverge from the
// emulated surface and hide client bugs). `n` is deliberately absent: Azure
// echoes `n:1` internally but rejects a client-supplied `tools[].n`.
const KNOWN_TOOL_FIELDS = new Set([
  'type', 'model', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation', 'partial_images', 'input_fidelity',
  'input_image_mask', 'action',
]);

export const isHostedImageGenerationTool = (tool: ResponseTool): tool is ResponseHostedTool =>
  tool.type === 'image_generation';

// The orchestrator-visible tool config the shim layers onto the backend
// call. Mirrors Azure: the orchestrator only chooses `prompt`; everything
// here is read from the client's hosted-tool entry and applied by the shim.
export interface ImageGenerationConfig {
  model: string;
  size?: string;
  quality?: string;
  output_format?: 'png' | 'jpeg';
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'auto' | 'low';
  output_compression?: number;
  // Validated but not forwarded: the shim drives a single non-streaming
  // backend call and emits one honest synthetic preview, so a requested
  // progressive-preview count cannot be reproduced (spec Part XIX).
  partial_images?: number;
  input_fidelity?: 'high' | 'low';
  // Inpainting mask as an inline image_url (data URL / base64), forwarded to
  // /images/edits as the standalone `mask` part. `file_id` masks are not
  // supported (rejected at validation) — resolving them needs the files API.
  mask?: string;
  action: 'generate' | 'edit' | 'auto';
}

export interface PrepareConfigError {
  message: string;
  param: string;
  code: 'unknown_parameter' | 'invalid_value' | 'integer_below_min_value' | 'integer_above_max_value';
}

export type PrepareConfigResult =
  | { ok: true; config: ImageGenerationConfig }
  | { ok: false; error: PrepareConfigError };

const invalidValue = (param: string, value: unknown, allowed: Iterable<string>): PrepareConfigError => ({
  message: `Invalid value: ${JSON.stringify(value)}. Supported values are: ${[...allowed].map(v => `'${v}'`).join(', ')}.`,
  param,
  code: 'invalid_value',
});

// Integer range check that mirrors Azure's distinct out-of-range codes
// (`integer_below_min_value` / `integer_above_max_value`) rather than
// collapsing them into a generic `invalid_value`.
const integerInRange = (value: unknown, param: string, min: number, max: number): PrepareConfigError | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `Invalid value: ${JSON.stringify(value)}. Expected an integer in [${min}, ${max}].`, param, code: 'invalid_value' };
  }
  if (value < min) return { message: `Invalid value: ${value}. Expected an integer >= ${min}.`, param, code: 'integer_below_min_value' };
  if (value > max) return { message: `Invalid value: ${value}. Expected an integer <= ${max}.`, param, code: 'integer_above_max_value' };
  return null;
};

// Validate one hosted `image_generation` entry against the public Responses
// surface and project it into the shim's config. Every hosted entry is
// validated (not just the last) so an earlier entry's bad field is rejected
// rather than masked by a later valid one — matching Azure's per-entry
// strictness with concrete `tools[i].field` paths.
const validateHostedImageGenerationEntry = (
  tool: ResponseHostedTool,
  index: number,
): { ok: true; config: ImageGenerationConfig } | { ok: false; error: PrepareConfigError } => {
  const path = (field: string): string => `tools[${index}].${field}`;

  // Reject any field outside the public surface (Azure-strict). This
  // subsumes `n` (absent from KNOWN_TOOL_FIELDS) and any typo'd / unsupported
  // field. First unknown key wins so the envelope names one offender.
  for (const key of Object.keys(tool)) {
    if (!KNOWN_TOOL_FIELDS.has(key) && (tool as Record<string, unknown>)[key] !== undefined) {
      return { ok: false, error: { message: `Unknown parameter: '${path(key)}'.`, param: path(key), code: 'unknown_parameter' } };
    }
  }

  const modelRaw = tool.model;
  if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== 'string' || modelRaw.length === 0)) {
    return { ok: false, error: { message: `Invalid value: ${JSON.stringify(modelRaw)}. Expected a non-empty model id.`, param: path('model'), code: 'invalid_value' } };
  }
  const size = tool.size;
  if (size !== undefined && size !== null && (typeof size !== 'string' || !ALLOWED_SIZES.has(size))) {
    return { ok: false, error: invalidValue(path('size'), size, ALLOWED_SIZES) };
  }
  const quality = tool.quality;
  if (quality !== undefined && quality !== null && (typeof quality !== 'string' || !ALLOWED_QUALITIES.has(quality))) {
    return { ok: false, error: invalidValue(path('quality'), quality, ALLOWED_QUALITIES) };
  }
  const background = tool.background;
  if (background !== undefined && background !== null && (typeof background !== 'string' || !ALLOWED_BACKGROUNDS.has(background))) {
    return { ok: false, error: invalidValue(path('background'), background, ALLOWED_BACKGROUNDS) };
  }
  const outputFormat = tool.output_format;
  if (outputFormat !== undefined && outputFormat !== null && (typeof outputFormat !== 'string' || !ALLOWED_OUTPUT_FORMATS.has(outputFormat))) {
    return { ok: false, error: invalidValue(path('output_format'), outputFormat, ALLOWED_OUTPUT_FORMATS) };
  }
  const moderation = tool.moderation;
  if (moderation !== undefined && moderation !== null && (typeof moderation !== 'string' || !ALLOWED_MODERATIONS.has(moderation))) {
    return { ok: false, error: invalidValue(path('moderation'), moderation, ALLOWED_MODERATIONS) };
  }
  const action = tool.action;
  if (action !== undefined && action !== null && (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action))) {
    return { ok: false, error: invalidValue(path('action'), action, ALLOWED_ACTIONS) };
  }
  const inputFidelity = tool.input_fidelity;
  if (inputFidelity !== undefined && inputFidelity !== null && (typeof inputFidelity !== 'string' || !ALLOWED_INPUT_FIDELITY.has(inputFidelity))) {
    return { ok: false, error: invalidValue(path('input_fidelity'), inputFidelity, ALLOWED_INPUT_FIDELITY) };
  }
  const compressionError = integerInRange(tool.output_compression, path('output_compression'), 0, 100);
  if (compressionError !== null) return { ok: false, error: compressionError };
  const partialError = integerInRange(tool.partial_images, path('partial_images'), 0, 3);
  if (partialError !== null) return { ok: false, error: partialError };

  // input_image_mask: inpainting mask. Accept an inline `image_url`
  // (data URL / base64) and validate that it decodes; `file_id` masks need
  // the files API to resolve to bytes and are not supported here. Reject a
  // malformed or unsupported mask rather than silently dropping the mask the
  // client expected to apply.
  const maskField = tool.input_image_mask;
  let mask: string | undefined;
  if (maskField !== undefined && maskField !== null) {
    if (typeof maskField !== 'object' || Array.isArray(maskField)) {
      return { ok: false, error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']) };
    }
    const maskUrl = (maskField as { image_url?: unknown }).image_url;
    if (typeof maskUrl !== 'string' || maskUrl.length === 0) {
      return {
        ok: false,
        error: { message: 'image_generation input_image_mask requires an inline `image_url`; `file_id` masks are not supported by this gateway.', param: path('input_image_mask'), code: 'invalid_value' },
      };
    }
    if (decodeInlineImage(maskUrl) === null) {
      return {
        ok: false,
        error: { message: 'image_generation input_image_mask.image_url must be an inline base64 data URL; remote URLs and malformed base64 are not supported.', param: path('input_image_mask'), code: 'invalid_value' },
      };
    }
    mask = maskUrl;
  }

  return {
    ok: true,
    config: {
      model: typeof modelRaw === 'string' && modelRaw.length > 0 ? modelRaw : DEFAULT_IMAGE_MODEL,
      ...(typeof size === 'string' ? { size } : {}),
      ...(typeof quality === 'string' ? { quality } : {}),
      ...(typeof outputFormat === 'string' ? { output_format: outputFormat as 'png' | 'jpeg' } : {}),
      ...(typeof background === 'string' ? { background: background as ImageGenerationConfig['background'] } : {}),
      ...(typeof moderation === 'string' ? { moderation: moderation as 'auto' | 'low' } : {}),
      ...(typeof tool.output_compression === 'number' ? { output_compression: tool.output_compression } : {}),
      ...(typeof tool.partial_images === 'number' ? { partial_images: tool.partial_images } : {}),
      ...(typeof inputFidelity === 'string' ? { input_fidelity: inputFidelity as 'high' | 'low' } : {}),
      ...(mask !== undefined ? { mask } : {}),
      action: (typeof action === 'string' ? action : 'auto') as ImageGenerationConfig['action'],
    },
  };
};

// Validate every hosted `image_generation` entry; the LAST entry's config
// wins (most-recent declaration), but any earlier entry's invalid field
// still rejects the request.
export const prepareImageGenerationConfig = (tools: readonly ResponseTool[]): PrepareConfigResult => {
  let config: ImageGenerationConfig | undefined;
  for (const [i, tool] of tools.entries()) {
    if (!isHostedImageGenerationTool(tool)) continue;
    const validated = validateHostedImageGenerationEntry(tool, i);
    if (!validated.ok) return validated;
    config = validated.config;
  }
  if (config === undefined) return { ok: false, error: { message: 'No image_generation tool present.', param: 'tools', code: 'unknown_parameter' } };
  return { ok: true, config };
};

// Single optional `prompt` parameter — matches the native `image_gen.imagegen`
// tool dumped 6/6-consistently from the orchestrator (size/quality/etc. are
// NOT model-chosen; the shim layers them on from the client config, exactly
// like Azure). A minimal description elicits native-quality refined prompts
// while costing ~50 input tokens vs the native hosted tool's ~2300.
export const buildImageGenerationFunctionTool = (name: string): ResponseFunctionTool => ({
  type: 'function',
  name,
  description:
    'Generate an image from a text description, or edit an attached image per instructions. '
    + 'Use it whenever the user asks for a picture, drawing, illustration, photo, diagram, or any visual, '
    + 'or wants to modify an attached image. Generate directly without asking for confirmation, '
    + 'and do not describe or comment on the image after generating it.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate or the edit to perform.' },
    },
    // Even `prompt` is optional on the native tool; the orchestrator may
    // call with no args and let the backend auto-prompt.
    required: [],
    additionalProperties: false,
  },
  // `strict: true` would require `required` to list every property; `prompt`
  // is intentionally optional, so the tool is non-strict.
  strict: false,
});

export const synthesizeImageGenerationCallId = (): string =>
  `ig_gw_${crypto.randomUUID().replace(/-/g, '')}`;

// A base64-data-URL or bare-base64 image source bound for an edit call.
// Bytes are held in a concrete ArrayBuffer so they can be wrapped in a Blob
// without TS narrowing complaints about SharedArrayBuffer.
interface ImageSource {
  bytes: ArrayBuffer;
  mimeType: string;
}

const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
};

// Parse a `data:<mime>;base64,<payload>` URL or a bare base64 string into
// raw bytes. Returns null for non-data URLs (e.g. http(s)): fetching remote
// images for edit binding is deferred — only inline image bytes are bound.
const decodeInlineImage = (imageUrl: string, fallbackMime = 'image/png'): ImageSource | null => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (dataUrlMatch === null) {
    if (/^https?:\/\//i.test(imageUrl)) return null;
    // Bare base64 (e.g. an image_generation_call.result).
    try {
      return { bytes: base64ToArrayBuffer(imageUrl), mimeType: fallbackMime };
    } catch {
      return null;
    }
  }
  const isBase64 = dataUrlMatch[2] !== undefined;
  const payload = dataUrlMatch[3];
  if (!isBase64) return null;
  try {
    return { bytes: base64ToArrayBuffer(payload), mimeType: dataUrlMatch[1] ?? fallbackMime };
  } catch {
    return null;
  }
};

// Collect all inline image sources from the original request input, in
// declaration order: `input_image` content blocks in messages, then
// full-echo `image_generation_call` items carrying `result` bytes. gpt-image
// selects the edit target by prompt semantics, so order is not significant
// and the shim attaches every source it finds (matching Azure).
export const collectImageSources = (input: ResponsesInvocation['payload']['input']): ImageSource[] => {
  if (!Array.isArray(input)) return [];
  const sources: ImageSource[] = [];
  for (const item of input) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block.type === 'input_image' && typeof block.image_url === 'string') {
          const decoded = decodeInlineImage(block.image_url);
          if (decoded !== null) sources.push(decoded);
        }
      }
      continue;
    }
    if (item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.length > 0) {
      // A prior generated image carries no MIME prefix on its bare-base64
      // `result`; pick the fallback from the echoed `output_format` so a
      // JPEG output is not mislabeled PNG on the edit form.
      const fallbackMime = item.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const decoded = decodeInlineImage(item.result, fallbackMime);
      if (decoded !== null) sources.push(decoded);
    }
  }
  return sources;
};

// The successfully-resolved image, or a normalized failure. Failures are
// replayed to the orchestrator as the tool's output (never synthesized into
// a downstream response.failed) so the model can retry, re-parameterize, or
// continue. The full upstream error shape (type/code/message) is preserved so
// the orchestrator can distinguish transient overload from a terminal
// content-policy block.
type ImageError = { type: string; code: string; message: string; retryable: boolean };
type ImageOutcome =
  | { ok: true; b64: string }
  | { ok: false; error: ImageError };

export type { ImageError, ImageOutcome };

const RETRYABLE_IMAGE_ERROR_CODES = new Set([
  'EngineOverloaded', 'server_error', 'image_generation_server_error', 'image_generation_failed',
]);

const isRetryableImageError = (code: string, type?: string): boolean =>
  RETRYABLE_IMAGE_ERROR_CODES.has(code) || (type !== undefined && RETRYABLE_IMAGE_ERROR_CODES.has(type));

const errorFromBody = (body: string, status: number): { type?: string; code: string; message: string } => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    const err = parsed.error;
    if (err !== undefined && err !== null) {
      return {
        ...(typeof err.type === 'string' ? { type: err.type } : {}),
        message: typeof err.message === 'string' ? err.message : `Image backend returned HTTP ${status}`,
        code: typeof err.code === 'string' ? err.code : `upstream_${status}`,
      };
    }
  } catch {
    // fall through to the status-only shape
  }
  return { message: `Image backend returned HTTP ${status}`, code: `upstream_${status}` };
};

// Per-request inputs the dispatcher's backend call needs. Captured in the
// registration closure from `ctx`/`request` so the (synchronous) dispatcher
// and its async result promise stay free of the interceptor signature.
interface ShimState {
  config: ImageGenerationConfig;
  imageSources: ImageSource[];
  apiKeyId: string | undefined;
  apiKeyUpstreamIds: readonly string[] | null | undefined;
  scheduleBackground: RequestContext['scheduleBackground'];
  downstreamAbortSignal: AbortSignal | undefined;
}

const recordImageUsage = (state: ShimState, binding: ProviderModelRecord, modelKey: string, responseBody: unknown): void => {
  if (state.apiKeyId === undefined) return;
  const usageBlock = responseBody !== null && typeof responseBody === 'object' ? (responseBody as { usage?: unknown }).usage : undefined;
  const usage = usageBlock !== undefined ? tokenUsageFromImagesResponse(usageBlock) : null;
  if (usage === null) return;
  const promise = recordTokenUsageForApiKey(state.apiKeyId, {
    model: binding.upstreamModel.id,
    upstream: binding.upstream,
    modelKey,
    cost: binding.provider.getPricingForModelKey(modelKey) ?? null,
  }, usage).catch((error: unknown) => {
    console.error('Failed to record image generation usage:', error);
  });
  state.scheduleBackground ? state.scheduleBackground(promise) : void promise;
};

export const buildGenerationsBody = (prompt: string, config: ImageGenerationConfig): Record<string, unknown> => ({
  prompt,
  // Public Responses tool config forbids `n`, but the private standalone
  // backend call always requests a single image, mirroring Azure's
  // single-image Responses behavior.
  n: 1,
  // `response_format` is intentionally not sent: gpt-image-* always returns
  // base64 (`data[0].b64_json`) and rejects `response_format`, so
  // `extractB64` reads `b64_json` directly.
  ...(config.size !== undefined ? { size: config.size } : {}),
  ...(config.quality !== undefined ? { quality: config.quality } : {}),
  ...(config.output_format !== undefined ? { output_format: config.output_format } : {}),
  ...(config.background !== undefined ? { background: config.background } : {}),
  ...(config.moderation !== undefined ? { moderation: config.moderation } : {}),
  ...(config.output_compression !== undefined ? { output_compression: config.output_compression } : {}),
});

const buildEditsForm = (prompt: string, config: ImageGenerationConfig, sources: readonly ImageSource[]): FormData => {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('n', '1');
  if (config.size !== undefined) form.append('size', config.size);
  if (config.quality !== undefined) form.append('quality', config.quality);
  if (config.output_format !== undefined) form.append('output_format', config.output_format);
  if (config.background !== undefined) form.append('background', config.background);
  if (config.moderation !== undefined) form.append('moderation', config.moderation);
  if (config.output_compression !== undefined) form.append('output_compression', String(config.output_compression));
  if (config.input_fidelity !== undefined) form.append('input_fidelity', config.input_fidelity);
  for (const [i, source] of sources.entries()) {
    const ext = source.mimeType === 'image/jpeg' ? 'jpg' : source.mimeType === 'image/webp' ? 'webp' : 'png';
    // `image[]` repeated parts: gpt-image accepts multiple, picking the
    // edit target by prompt semantics. Attach order is not significant.
    form.append('image[]', new Blob([source.bytes], { type: source.mimeType }), `image_${i}.${ext}`);
  }
  const maskSource = config.mask !== undefined ? decodeInlineImage(config.mask) : null;
  if (maskSource !== null) {
    const ext = maskSource.mimeType === 'image/jpeg' ? 'jpg' : maskSource.mimeType === 'image/webp' ? 'webp' : 'png';
    form.append('mask', new Blob([maskSource.bytes], { type: maskSource.mimeType }), `mask.${ext}`);
  }
  return form;
};

const extractB64 = (body: unknown): string | null => {
  if (body === null || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { b64_json?: unknown };
  return typeof first.b64_json === 'string' ? first.b64_json : null;
};

// Resolve the image backend, issue the standalone call, and normalize the
// outcome. Backend/transport failures become `{ok:false}` outcomes rather
// than throwing, so the dispatcher always yields a terminal image item.
const runImageBackend = async (prompt: string, isEdit: boolean, state: ShimState): Promise<ImageOutcome> => {
  const endpoint = isEdit ? 'images_edits' : 'images_generations';
  let resolution;
  try {
    resolution = await resolveModelForRequest(state.config.model, state.apiKeyUpstreamIds);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { type: 'image_generation_error', message, code: 'server_error', retryable: true } };
  }
  const binding = resolution.model?.providers.find(b => b.upstreamModel.upstreamEndpoints.includes(endpoint));
  if (binding === undefined) {
    return {
      ok: false,
      error: {
        type: 'image_generation_error',
        message: `No upstream provides model '${state.config.model}' for the /${endpoint.replace('_', '/')} endpoint.`,
        code: 'model_not_found',
        retryable: false,
      },
    };
  }

  try {
    const { response, modelKey } = isEdit
      ? await binding.provider.callImagesEdits(binding.upstreamModel, buildEditsForm(prompt, state.config, state.imageSources), state.downstreamAbortSignal)
      : await binding.provider.callImagesGenerations(binding.upstreamModel, buildGenerationsBody(prompt, state.config), state.downstreamAbortSignal);

    const text = await response.text();
    if (!response.ok) {
      const { type, code, message } = errorFromBody(text, response.status);
      return { ok: false, error: { type: type ?? 'image_generation_error', code, message, retryable: isRetryableImageError(code, type) } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: { type: 'image_generation_error', message: 'Image backend returned a non-JSON success body.', code: 'server_error', retryable: true } };
    }
    const b64 = extractB64(parsed);
    if (b64 === null) {
      return { ok: false, error: { type: 'image_generation_error', message: 'Image backend response did not contain image bytes.', code: 'server_error', retryable: true } };
    }
    recordImageUsage(state, binding, modelKey, parsed);
    return { ok: true, b64 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { type: 'image_generation_error', message, code: 'server_error', retryable: true } };
  }
};

const resolvedBackground = (config: ImageGenerationConfig): 'transparent' | 'opaque' | undefined => {
  if (config.background === 'transparent') return 'transparent';
  if (config.background === 'opaque') return 'opaque';
  // `auto` is resolved server-side; leave it unset rather than asserting a
  // value the backend chooses.
  return undefined;
};

const resolvedQuality = (config: ImageGenerationConfig): 'low' | 'medium' | 'high' | undefined =>
  config.quality === 'low' || config.quality === 'medium' || config.quality === 'high' ? config.quality : undefined;

// The resolved config fields echoed on both the partial_image event and the
// completed item, matching Azure's native wire shape. `size` is omitted when
// `auto` (server resolves it); `background`/`quality` are omitted unless a
// concrete value was requested.
const resolvedEchoFields = (config: ImageGenerationConfig): {
  output_format: 'png' | 'jpeg';
  quality?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque';
  size?: string;
} => ({
  output_format: config.output_format ?? 'png',
  ...(resolvedQuality(config) !== undefined ? { quality: resolvedQuality(config) } : {}),
  ...(resolvedBackground(config) !== undefined ? { background: resolvedBackground(config) } : {}),
  ...(config.size !== undefined && config.size !== 'auto' ? { size: config.size } : {}),
});

// Build the completed/failed `image_generation_call` output item plus its
// terminal lifecycle events. On success the final bytes ride both the last
// `partial_image` event and `output_item.done.item.result` (byte-equal, per
// the native wire shape); on failure neither `.partial_image` nor
// `.completed` is emitted — only the failed `output_item.done`.
//
// `revised_prompt` is set to the orchestrator's prompt: the standalone images
// backend does no prompt rewriting and returns no `revised_prompt`, and the
// orchestrator's emitted prompt IS already its refined rewrite (it plays the
// role Azure's native flow gives the orchestrator), so it is the faithful
// source for this field.
export const buildResultFrames = (
  id: string,
  prompt: string,
  action: 'generate' | 'edit',
  config: ImageGenerationConfig,
  outcome: ImageOutcome,
): { item: ServerToolOutputItem; endEvents: ServerToolLifecycleEvent[] } => {
  if (!outcome.ok) {
    const item: ServerToolOutputItem & Omit<ResponseOutputImageGenerationCall, 'id'> = {
      type: 'image_generation_call',
      status: 'failed',
      revised_prompt: prompt,
      error: { message: outcome.error.message, code: outcome.error.code, type: outcome.error.type },
    };
    return { item, endEvents: [] };
  }

  const echo = resolvedEchoFields(config);
  const item: ServerToolOutputItem & Omit<ResponseOutputImageGenerationCall, 'id'> = {
    type: 'image_generation_call',
    status: 'completed',
    action,
    result: outcome.b64,
    revised_prompt: prompt,
    ...echo,
  };
  const endEvents: ServerToolLifecycleEvent[] = [
    // One honest preview: the standalone backend delivers a single final
    // image, so the shim cannot fabricate N progressive previews. Index 0
    // carries the final bytes, byte-equal to `item.result`. The resolved
    // config fields ride along, matching Azure's partial_image payload.
    { type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: outcome.b64, ...echo },
    { type: 'response.image_generation_call.completed' },
  ];
  return { item, endEvents };
};

// Output-as-input round-trip: the multi-turn loop feeds accumulated
// `image_generation_call` items back as the next turn's input, and client
// histories may echo prior ones. Non-Responses upstreams can't read the item
// type, so rewrite each into a `function_call` + `function_call_output` pair
// so the orchestrator sees that it called the tool and what it returned. For
// a successful call we additionally surface the generated bytes as an
// `input_image` message, matching Azure's native flow where the image stays
// in the orchestrator's multimodal context — so the model can describe or
// iteratively edit what it just produced. The same bytes also reached the
// downstream client on the synthesized `image_generation_call` item.
//
// Fidelity vs persistence: within one response this is lossless (we just
// synthesized the item, so `result`/`revised_prompt`/`status`/`error` are all
// present, and `call_id` is derived from `id`). Across requests it depends on
// what the client echoes back — a Mode-B reference that carries only `id`
// (bytes dropped) can be neither fed back nor bound for an edit until a
// stateful response store lets us look the item up by `id`. Crucially the
// `image_generation_call` shape is self-sufficient: every field needed to
// rebuild the pair, INCLUDING the error (`status` + `error{message,code}`),
// has a public home, so that store only needs to persist the public item —
// there is no out-of-band payload to keep. When it lands, this seam should
// restore the persisted item by `id` first, falling back to the wire item.
export const transformInputItemsForImageGeneration = (
  input: ResponseInputItem[],
  toolName: string,
): ResponseInputItem[] => {
  const out: ResponseInputItem[] = [];
  for (const item of input) {
    if (item.type !== 'image_generation_call') {
      out.push(item);
      continue;
    }
    const ig = item as ResponseInputImageGenerationCall;
    const id = ig.id !== undefined && ig.id.length > 0 ? ig.id : synthesizeImageGenerationCallId();
    const callId = `cc_from_${id}`;
    // Replay the full failure detail (code/message/retryable) the orchestrator
    // needs to decide between retry, re-parameterize, and apology — a bare
    // status would hide whether the failure was transient (EngineOverloaded)
    // or terminal (content_filter).
    const output = ig.status === 'failed'
      ? JSON.stringify({
          ok: false,
          error: {
            type: ig.error?.type ?? 'image_generation_error',
            code: ig.error?.code ?? 'server_error',
            message: ig.error?.message ?? 'Image generation failed.',
            retryable: isRetryableImageError(ig.error?.code ?? '', ig.error?.type),
          },
        })
      : JSON.stringify({ ok: true, status: 'completed', id });
    const functionCall: ResponseFunctionToolCallItem = {
      type: 'function_call',
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify({ prompt: ig.revised_prompt ?? '' }),
      status: 'completed',
    };
    const functionCallOutput: ResponseFunctionCallOutputItem = {
      type: 'function_call_output',
      call_id: callId,
      output,
    };
    out.push(functionCall, functionCallOutput);

    if (ig.status !== 'failed' && typeof ig.result === 'string' && ig.result.length > 0) {
      const mime = ig.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
      out.push({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Generated image:' },
          { type: 'input_image', image_url: `data:${mime};base64,${ig.result}`, detail: 'auto' },
        ],
      });
    }
  }
  return out;
};

export const imageGenerationServerTool: ServerToolRegistration = (ctx, request) => {
  if (ctx.targetApi === 'responses' && !ctx.enabledFlags.has('responses-image-generation-shim')) {
    return { type: 'inactive' };
  }

  const tools = Array.isArray(ctx.payload.tools) ? ctx.payload.tools : [];
  const hasHostedTool = tools.some(isHostedImageGenerationTool);
  const hasReplayInput = Array.isArray(ctx.payload.input) && ctx.payload.input.some(i => i.type === 'image_generation_call');
  if (!hasHostedTool && !hasReplayInput) return { type: 'inactive' };

  if (!hasHostedTool) {
    // Replay-only activation: rewrite echoed image_generation_call items so
    // the upstream can read them, but there is no hosted tool to dispatch.
    return {
      type: 'active',
      baseToolName: SHIM_TOOL_NAME,
      transformItems: (items, toolName) => transformInputItemsForImageGeneration(items, toolName),
    };
  }

  const prepared = prepareImageGenerationConfig(tools);
  if (!prepared.ok) {
    return { type: 'invalid-request', message: prepared.error.message, param: prepared.error.param, code: prepared.error.code };
  }
  const config = prepared.config;
  const imageSources = collectImageSources(ctx.payload.input);

  // `action:"edit"` with no bindable image is a client request-shape error,
  // surfaced before the model loop because it is not a runtime backend
  // failure.
  if (config.action === 'edit' && imageSources.length === 0) {
    return {
      type: 'invalid-request',
      message: 'image_generation action "edit" requires at least one input image, but none was found in the request input.',
      param: 'input',
      code: 'invalid_value',
    };
  }

  const isEdit = config.action === 'edit' || (config.action === 'auto' && imageSources.length > 0);
  const action: 'generate' | 'edit' = isEdit ? 'edit' : 'generate';

  // A mask only applies to an edit; if the request resolves to a generate
  // (no input image, or action:"generate"), the mask could never be used —
  // reject rather than silently dropping it.
  if (config.mask !== undefined && !isEdit) {
    return {
      type: 'invalid-request',
      message: 'image_generation input_image_mask is only valid for an edit; provide an input image (and do not force action "generate").',
      param: 'tools',
      code: 'invalid_value',
    };
  }

  const state: ShimState = {
    config,
    imageSources,
    apiKeyId: request.apiKeyId,
    apiKeyUpstreamIds: request.apiKeyUpstreamIds,
    scheduleBackground: request.scheduleBackground,
    downstreamAbortSignal: request.downstreamAbortSignal,
  };

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    transformItems: (items, toolName) => transformInputItemsForImageGeneration(items, toolName),
    hosted: {
      isHostedTool: isHostedImageGenerationTool,
      buildFunctionTool: toolName => buildImageGenerationFunctionTool(toolName),
      dispatcher: ({ intercepted, loopState }) => {
        const promptArg = intercepted.arguments !== null && typeof intercepted.arguments.prompt === 'string'
          ? intercepted.arguments.prompt
          : '';
        const id = synthesizeImageGenerationCallId();
        // Safety valve against an unbounded backend-call loop (the model
        // retrying after repeated {ok:false} outcomes): once the turn count
        // passes the cap, stop hitting the backend and replay an exhausted
        // tool output so the model steers toward a terminal answer.
        if (loopState.iterationCount > IMAGE_ITERATION_CAP) {
          return [serverToolResultSlot({
            id,
            startItem: { type: 'image_generation_call', status: 'in_progress' },
            startEvents: [{ type: 'response.image_generation_call.in_progress' }, { type: 'response.image_generation_call.generating' }],
            result: Promise.resolve(buildResultFrames(id, promptArg, action, config, {
              ok: false,
              error: { type: 'image_generation_error', code: 'tool_call_budget_exhausted', message: `Image generation budget (${IMAGE_ITERATION_CAP} attempts) reached for this response. Summarize and finish without another image.`, retryable: false },
            })),
          })];
        }
        return [serverToolResultSlot({
          id,
          startItem: { type: 'image_generation_call', status: 'in_progress' },
          startEvents: [
            { type: 'response.image_generation_call.in_progress' },
            { type: 'response.image_generation_call.generating' },
          ],
          result: runImageBackend(promptArg, isEdit, state).then(outcome =>
            buildResultFrames(id, promptArg, action, config, outcome)),
        })];
      },
    },
  };
};
