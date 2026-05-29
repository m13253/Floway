import { test } from 'vitest';

import {
  buildGenerationsBody,
  buildImageGenerationFunctionTool,
  buildResultFrames,
  collectImageSources,
  DEFAULT_IMAGE_MODEL,
  type ImageGenerationConfig,
  type ImageOutcome,
  isHostedImageGenerationTool,
  prepareImageGenerationConfig,
  SHIM_TOOL_NAME,
  synthesizeImageGenerationCallId,
  transformInputItemsForImageGeneration,
} from './image-generation.ts';
import { assert, assertEquals, assertFalse, assertStringIncludes } from '../../../../../../test-assert.ts';
import type { ResponseInputItem, ResponseTool } from '@floway-dev/protocols/responses';

const PNG_B64 = 'aGVsbG8='; // "hello" — any decodable base64 works for source tests.

// ── isHostedImageGenerationTool ──

test('isHostedImageGenerationTool matches only the hosted image_generation type', () => {
  assert(isHostedImageGenerationTool({ type: 'image_generation' } as ResponseTool));
  assertFalse(isHostedImageGenerationTool({ type: 'custom', name: 'x' } as ResponseTool));
  assertFalse(isHostedImageGenerationTool({ type: 'function', name: 'x', parameters: {}, strict: false } as ResponseTool));
});

// ── prepareImageGenerationConfig ──

test('prepareImageGenerationConfig accepts a valid hosted entry and defaults the model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', quality: 'low', size: '1024x1024' } as ResponseTool]);
  assert(result.ok);
  assertEquals(result.config.model, DEFAULT_IMAGE_MODEL);
  assertEquals(result.config.quality, 'low');
  assertEquals(result.config.size, '1024x1024');
  assertEquals(result.config.action, 'auto');
});

test('prepareImageGenerationConfig honors an explicit model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: 'gpt-image-1.5' } as ResponseTool]);
  assert(result.ok);
  assertEquals(result.config.model, 'gpt-image-1.5');
});

test('prepareImageGenerationConfig rejects any client-supplied n, including n:1', () => {
  for (const n of [2, 1, 0]) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', n } as ResponseTool]);
    assertFalse(result.ok);
    assert(!result.ok);
    assertEquals(result.error.code, 'unknown_parameter');
    assertEquals(result.error.param, 'tools[0].n');
  }
});

test('prepareImageGenerationConfig rejects output_format webp', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_format: 'webp' } as ResponseTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].output_format');
});

test('prepareImageGenerationConfig rejects an arbitrary size', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', size: '512x512' } as ResponseTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].size');
});

test('prepareImageGenerationConfig accepts auto for size/quality/background', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', size: 'auto', quality: 'auto', background: 'auto' } as ResponseTool]);
  assert(result.ok);
  assertEquals(result.config.size, 'auto');
  assertEquals(result.config.quality, 'auto');
  assertEquals(result.config.background, 'auto');
});

test('prepareImageGenerationConfig rejects an invalid action', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', action: 'morph' } as ResponseTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].action');
});

test('prepareImageGenerationConfig takes the last hosted entry when several are present', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', quality: 'low' } as ResponseTool,
    { type: 'image_generation', quality: 'high' } as ResponseTool,
  ]);
  assert(result.ok);
  assertEquals(result.config.quality, 'high');
});

test('prepareImageGenerationConfig reports the concrete tool index in error.param', () => {
  const result = prepareImageGenerationConfig([
    { type: 'function', name: 'x', parameters: {}, strict: false } as ResponseTool,
    { type: 'image_generation', size: '99x99' } as ResponseTool,
  ]);
  assert(!result.ok);
  assertEquals(result.error.param, 'tools[1].size');
});

test('prepareImageGenerationConfig accepts output_compression in range and passes it through', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: 80 } as ResponseTool]);
  assert(result.ok);
  assertEquals(result.config.output_compression, 80);
});

test('prepareImageGenerationConfig rejects out-of-range output_compression', () => {
  const cases: [number, string][] = [[-1, 'integer_below_min_value'], [101, 'integer_above_max_value'], [50.5, 'invalid_value']];
  for (const [v, code] of cases) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: v } as ResponseTool]);
    assert(!result.ok);
    assertEquals(result.error.code, code);
    assertEquals(result.error.param, 'tools[0].output_compression');
  }
});

test('prepareImageGenerationConfig rejects unknown tool fields (Azure-strict)', () => {
  for (const field of ['seed', 'thinking', 'made_up_field']) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', [field]: 1 } as ResponseTool]);
    assert(!result.ok);
    assertEquals(result.error.code, 'unknown_parameter');
    assertEquals(result.error.param, `tools[0].${field}`);
  }
});

test('prepareImageGenerationConfig validates input_fidelity and partial_images', () => {
  const okFidelity = prepareImageGenerationConfig([{ type: 'image_generation', input_fidelity: 'high' } as ResponseTool]);
  assert(okFidelity.ok);
  assertEquals(okFidelity.config.input_fidelity, 'high');

  const badFidelity = prepareImageGenerationConfig([{ type: 'image_generation', input_fidelity: 'ultra' } as ResponseTool]);
  assert(!badFidelity.ok);
  assertEquals(badFidelity.error.param, 'tools[0].input_fidelity');

  const okPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 2 } as ResponseTool]);
  assert(okPartial.ok);
  assertEquals(okPartial.config.partial_images, 2);

  const badPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 9 } as ResponseTool]);
  assert(!badPartial.ok);
  assertEquals(badPartial.error.param, 'tools[0].partial_images');
});

test('prepareImageGenerationConfig accepts an inline mask but rejects a file_id mask', () => {
  const ok = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` } } as ResponseTool]);
  assert(ok.ok);
  assertEquals(ok.config.mask, `data:image/png;base64,${PNG_B64}`);

  const fileId = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { file_id: 'file_123' } } as ResponseTool]);
  assert(!fileId.ok);
  assertEquals(fileId.error.code, 'invalid_value');
  assertEquals(fileId.error.param, 'tools[0].input_image_mask');
});

// ── buildImageGenerationFunctionTool ──

test('buildImageGenerationFunctionTool exposes only an optional prompt and is non-strict', () => {
  const tool = buildImageGenerationFunctionTool(SHIM_TOOL_NAME);
  assertEquals(tool.type, 'function');
  assertEquals(tool.name, SHIM_TOOL_NAME);
  assertEquals(tool.strict, false);
  const params = tool.parameters as { properties: Record<string, unknown>; required: unknown[]; additionalProperties: unknown };
  assertEquals(Object.keys(params.properties), ['prompt']);
  assertEquals(params.required.length, 0);
  assertEquals(params.additionalProperties, false);
});

// ── collectImageSources ──

test('collectImageSources reads input_image blocks and image_generation_call results', () => {
  const input: ResponseInputItem[] = [
    {
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'edit this' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' },
      ],
    },
    { type: 'image_generation_call', id: 'ig_prev', status: 'completed', result: PNG_B64 },
  ];
  const sources = collectImageSources(input);
  assertEquals(sources.length, 2);
});

test('collectImageSources skips http(s) image urls (remote fetch deferred)', () => {
  const input: ResponseInputItem[] = [
    {
      type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
      ],
    },
  ];
  assertEquals(collectImageSources(input).length, 0);
});

test('collectImageSources returns empty for a plain string input', () => {
  assertEquals(collectImageSources('just text').length, 0);
});

// ── transformInputItemsForImageGeneration ──

test('transformInputItemsForImageGeneration rewrites a completed call into a function_call + output pair and feeds the image back', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64, revised_prompt: 'a red dot', output_format: 'jpeg' }],
    'image_generation',
  );
  assertEquals(out.length, 3);
  assert(out[0].type === 'function_call');
  assertEquals(out[0].name, 'image_generation');
  assertEquals(out[0].call_id, 'cc_from_ig_1');
  assertStringIncludes(out[0].arguments, 'a red dot');
  assert(out[1].type === 'function_call_output');
  assertEquals(out[1].call_id, 'cc_from_ig_1');
  assertStringIncludes(out[1].output, '"ok":true');
  // The generated image is fed back so the orchestrator can see it.
  assert(out[2].type === 'message');
  assert(Array.isArray(out[2].content));
  const imageBlock = out[2].content.find(b => b.type === 'input_image');
  assert(imageBlock !== undefined);
  assertEquals((imageBlock as { image_url: string }).image_url, `data:image/jpeg;base64,${PNG_B64}`);
});

test('transformInputItemsForImageGeneration does not feed back an image for a failed call', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_f', status: 'failed', error: { message: 'x', code: 'server_error' } }],
    'image_generation',
  );
  assertEquals(out.length, 2);
  assertFalse(out.some(i => i.type === 'message'));
});

test('transformInputItemsForImageGeneration encodes a failed call as ok:false with error detail', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_2', status: 'failed', revised_prompt: 'x', error: { message: 'overloaded', code: 'EngineOverloaded' } }],
    'image_generation',
  );
  assert(out[1].type === 'function_call_output');
  const parsed = JSON.parse(out[1].output) as { ok: boolean; error: { code: string; message: string; retryable: boolean } };
  assertEquals(parsed.ok, false);
  assertEquals(parsed.error.code, 'EngineOverloaded');
  assertEquals(parsed.error.message, 'overloaded');
  assertEquals(parsed.error.retryable, true);
});

test('transformInputItemsForImageGeneration passes non-image items through untouched', () => {
  const message: ResponseInputItem = { type: 'message', role: 'user', content: 'hi' };
  const out = transformInputItemsForImageGeneration([message], 'image_generation');
  assertEquals(out.length, 1);
  assertEquals(out[0], message);
});

// ── buildGenerationsBody ──

test('buildGenerationsBody always sends n:1 and maps config, omitting undefined', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', size: '1024x1024', quality: 'low', action: 'generate' };
  const body = buildGenerationsBody('a cat', config);
  assertEquals(body.prompt, 'a cat');
  assertEquals(body.n, 1);
  assertEquals(body.size, '1024x1024');
  assertEquals(body.quality, 'low');
  assertFalse('background' in body);
  assertFalse('output_format' in body);
});

// ── buildResultFrames ──

test('buildResultFrames on success emits a partial_image then completed and a completed item', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', size: '1024x1024', quality: 'high', output_format: 'png', action: 'generate' };
  const outcome: ImageOutcome = { ok: true, b64: PNG_B64 };
  const { item, endEvents } = buildResultFrames('ig_x', 'a red dot', 'generate', config, outcome);
  assertEquals((item as { status?: string }).status, 'completed');
  assertEquals((item as { result?: string }).result, PNG_B64);
  assertEquals((item as { revised_prompt?: string }).revised_prompt, 'a red dot');
  assertEquals((item as { action?: string }).action, 'generate');
  assertEquals((item as { quality?: string }).quality, 'high');
  assertEquals((item as { size?: string }).size, '1024x1024');
  assertEquals(endEvents.length, 2);
  assertEquals(endEvents[0].type, 'response.image_generation_call.partial_image');
  assertEquals((endEvents[0] as { partial_image_index?: number }).partial_image_index, 0);
  assertEquals((endEvents[0] as { partial_image_b64?: string }).partial_image_b64, PNG_B64);
  // Resolved config echoed on the preview event, mirroring Azure.
  assertEquals((endEvents[0] as { output_format?: string }).output_format, 'png');
  assertEquals((endEvents[0] as { quality?: string }).quality, 'high');
  assertEquals((endEvents[0] as { size?: string }).size, '1024x1024');
  assertEquals(endEvents[1].type, 'response.image_generation_call.completed');
});

test('buildResultFrames on failure emits a failed item and no lifecycle end events', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', action: 'generate' };
  const outcome: ImageOutcome = { ok: false, error: { type: 'image_generation_user_error', message: 'overloaded', code: 'EngineOverloaded', retryable: true } };
  const { item, endEvents } = buildResultFrames('ig_y', 'a red dot', 'generate', config, outcome);
  assertEquals((item as { status?: string }).status, 'failed');
  assertEquals((item as { error?: { code: string } }).error?.code, 'EngineOverloaded');
  assertEquals((item as { error?: { type?: string } }).error?.type, 'image_generation_user_error');
  assertFalse('result' in item);
  assertEquals(endEvents.length, 0);
});

test('prepareImageGenerationConfig rejects a present-but-invalid model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: '' } as ResponseTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].model');
});

test('prepareImageGenerationConfig validates every hosted entry, not just the last', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', n: 2 } as ResponseTool,
    { type: 'image_generation', quality: 'low' } as ResponseTool,
  ]);
  assert(!result.ok);
  assertEquals(result.error.code, 'unknown_parameter');
  assertEquals(result.error.param, 'tools[0].n');
});

test('prepareImageGenerationConfig uses Azure integer-range codes', () => {
  const below = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: -1 } as ResponseTool]);
  assert(!below.ok);
  assertEquals(below.error.code, 'integer_below_min_value');
  const above = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: 200 } as ResponseTool]);
  assert(!above.ok);
  assertEquals(above.error.code, 'integer_above_max_value');
});

test('prepareImageGenerationConfig rejects a non-decodable mask', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { image_url: 'https://example.com/m.png' } } as ResponseTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].input_image_mask');
});

test('transformInputItemsForImageGeneration preserves error type and retryability on replay', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_3', status: 'failed', error: { message: 'blocked', code: 'content_filter', type: 'image_generation_user_error' } }],
    'image_generation',
  );
  assert(out[1].type === 'function_call_output');
  const parsed = JSON.parse(out[1].output) as { error: { type: string; code: string; retryable: boolean } };
  assertEquals(parsed.error.type, 'image_generation_user_error');
  assertEquals(parsed.error.code, 'content_filter');
  assertEquals(parsed.error.retryable, false);
});

test('buildResultFrames omits size when the config requested auto', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', size: 'auto', action: 'generate' };
  const { item } = buildResultFrames('ig_z', 'p', 'generate', config, { ok: true, b64: PNG_B64 });
  assertFalse('size' in item);
});

// ── synthesizeImageGenerationCallId ──

test('synthesizeImageGenerationCallId produces an ig_gw_-prefixed id', () => {
  const id = synthesizeImageGenerationCallId();
  assert(id.startsWith('ig_gw_'));
  assert(id.length > 'ig_gw_'.length);
});
