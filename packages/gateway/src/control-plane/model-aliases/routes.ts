import type { Context } from 'hono';

import { aliasToJson } from './serialize.ts';
import type { ModelAlias } from './types.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { createAliasBody, updateAliasBody } from '../schemas.ts';

export const listAliases = async (c: Context) => {
  const aliases = await getRepo().modelAliases.loadAll();
  return c.json(aliases.map(aliasToJson));
};

export const createAlias = async (c: CtxWithJson<typeof createAliasBody>) => {
  const body = c.req.valid('json');
  const record: ModelAlias = {
    alias: body.alias,
    targetModelId: body.targetModelId,
    upstreamIds: body.upstreamIds,
    rules: body.rules,
    visibleInModelsList: body.visibleInModelsList,
    // `real-only` is the safe default: an alias whose target id collides with
    // a real model id stays hidden until the operator opts the alias into one
    // of the surfacing modes. Matches the migration's column default.
    onConflict: body.onConflict ?? 'real-only',
    ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    createdAt: Math.floor(Date.now() / 1000),
  };

  const result = await getRepo().modelAliases.create(record);
  if (!result.ok) {
    return c.json({ error: { type: 'conflict', message: `Alias "${body.alias}" already exists` } }, 409);
  }

  return c.json(aliasToJson(record), 201);
};

export const updateAlias = async (c: CtxWithJson<typeof updateAliasBody>) => {
  const aliasName = c.req.param('alias')!;
  const body = c.req.valid('json');

  const repo = getRepo();
  const existing = await repo.modelAliases.getByAlias(aliasName);
  if (!existing) return c.json({ error: 'Alias not found' }, 404);

  // Rename runs first so the merged save below targets the row at its new
  // PK. A no-op (alias unchanged or omitted) returns ok without touching
  // the row.
  const nextAlias = body.alias ?? existing.alias;
  if (nextAlias !== existing.alias) {
    const renamed = await repo.modelAliases.rename(existing.alias, nextAlias);
    if (!renamed.ok) {
      return c.json({ error: { type: 'conflict', message: `Alias "${nextAlias}" already exists` } }, 409);
    }
  }

  // Field-by-field merge so an absent field preserves the existing value.
  // `displayName` accepts an explicit null to clear the operator-set label
  // back to the synthesized fallback; we use Object.hasOwn to keep the
  // absent / null distinction that `??` would collapse.
  const merged: ModelAlias = {
    alias: nextAlias,
    targetModelId: body.targetModelId ?? existing.targetModelId,
    upstreamIds: body.upstreamIds ?? existing.upstreamIds,
    rules: body.rules ?? existing.rules,
    visibleInModelsList: body.visibleInModelsList ?? existing.visibleInModelsList,
    onConflict: body.onConflict ?? existing.onConflict,
    createdAt: existing.createdAt,
    ...nextDisplayName(existing, body.displayName),
  };

  await repo.modelAliases.save(merged);
  return c.json(aliasToJson(merged));
};

const nextDisplayName = (existing: ModelAlias, patch: string | null | undefined): { displayName?: string } => {
  if (patch === undefined) return existing.displayName !== undefined ? { displayName: existing.displayName } : {};
  if (patch === null) return {};
  return { displayName: patch };
};

export const deleteAlias = async (c: Context) => {
  const aliasName = c.req.param('alias')!;
  const { deleted } = await getRepo().modelAliases.delete(aliasName);
  if (!deleted) return c.json({ error: 'Alias not found' }, 404);
  return c.body(null, 204);
};
