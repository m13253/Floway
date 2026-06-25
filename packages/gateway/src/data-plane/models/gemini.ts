import type { Context } from 'hono';

import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { geminiStatusForHttpStatus } from '../chat/gemini/errors.ts';
import { getInternalModels } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { Fetcher, InternalModel } from '@floway-dev/provider';

type GeminiGenerationMethod = 'generateContent' | 'streamGenerateContent' | 'countTokens';

interface GeminiModel {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: GeminiGenerationMethod[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  cost?: ModelPricing;
}

const toGeminiModel = (model: InternalModel): GeminiModel => {
  const limits = model.limits;
  const inputTokenLimit = limits.max_prompt_tokens ?? limits.max_context_window_tokens;
  const outputTokenLimit = limits.max_output_tokens;

  return {
    name: `models/${model.id}`,
    baseModelId: model.id,
    displayName: model.display_name ?? model.id,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    temperature: 1,
    topP: 0.95,
    topK: 40,
    ...(model.cost ? { cost: model.cost } : {}),
  };
};

const geminiError = (status: number, message: string): Response =>
  Response.json(
    { error: { code: status, message, status: geminiStatusForHttpStatus(status) } },
    { status: status as 400 | 404 | 500 | 502 },
  );

const geminiModelLoadError = (error: unknown): Response => {
  if (error instanceof ProviderModelsUnavailableError) {
    return geminiError(502, MODEL_LISTING_FAILURE_MESSAGE);
  }
  return geminiError(502, error instanceof Error ? error.message : String(error));
};

const loadGeminiModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[],
): Promise<GeminiModel[]> => {
  const models = await getInternalModels(upstreamFilter, fetcherForUpstream, scheduler);
  // Only chat models are representable in the Gemini /models shape.
  const realChatEntries = models.filter(model => model.kind === 'chat').map(toGeminiModel);
  // Visible aliases append in `loadAllAliases` order; the Gemini surface
  // carries no `aliasedFrom` extension (Gemini's `Model` resource is closed)
  // so the entry advertises the alias id plus the target's display fields.
  const byId = new Map<string, InternalModel>(models.map(m => [m.id, m]));
  const aliasEntries: GeminiModel[] = [];
  for (const alias of aliases) {
    if (!alias.visibleInModelsList) continue;
    const target = byId.get(alias.targetModelId);
    if (target && target.kind !== 'chat') continue;
    aliasEntries.push(toGeminiModel({
      ...(target ?? {} as InternalModel),
      id: alias.alias,
      display_name: alias.alias,
      kind: 'chat',
      limits: target?.limits ?? {},
    }));
  }
  return [...realChatEntries, ...aliasEntries];
};

export const serveGeminiModels = async (c: Context): Promise<Response> => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const aliases = await getRepo().modelAliases.loadAll();
    return Response.json({ models: await loadGeminiModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), aliases) });
  } catch (error) {
    return geminiModelLoadError(error);
  }
};

export const serveGeminiModelInfo = async (c: Context): Promise<Response> => {
  const rawModelId = c.req.param('modelId');
  if (!rawModelId) return geminiError(404, 'Model not found: ');

  const modelId = rawModelId.replace(/^models\//, '');
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const aliases = await getRepo().modelAliases.loadAll();
    const model = (await loadGeminiModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), aliases)).find(candidate => candidate.baseModelId === modelId || candidate.name === `models/${modelId}`);
    if (!model) return geminiError(404, `Model not found: ${modelId}`);
    return Response.json(model);
  } catch (error) {
    return geminiModelLoadError(error);
  }
};
