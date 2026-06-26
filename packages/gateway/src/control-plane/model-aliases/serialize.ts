// Snake_case wire <-> camelCase record conversion for model aliases. The wire
// shape (`ModelAlias`) lives in `@floway-dev/protocols/common` so the
// dashboard and the control plane share one source of truth; this file is
// the only place those two shapes meet.

import type { ModelAliasRecord } from '../../repo/types.ts';
import type { AliasKind, AliasSelection, AliasTarget, ModelAlias } from '@floway-dev/protocols/common';

export const recordToWire = (record: ModelAliasRecord): ModelAlias => ({
  name: record.name,
  kind: record.kind,
  selection: record.selection,
  display_name: record.displayName,
  visible_in_models_list: record.visibleInModelsList,
  targets: record.targets,
  sort_order: record.sortOrder,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

// Wire payload accepted by the create / update body schemas. Every field
// except `sort_order` is required at this layer; the route owns how the
// sort order and timestamps are produced before calling wireToRecord.
export interface ModelAliasWireInput {
  name: string;
  kind: AliasKind;
  selection: AliasSelection;
  display_name: string | null;
  visible_in_models_list: boolean;
  targets: AliasTarget[];
  sort_order?: number;
}

// Build a record from a validated wire payload. The caller supplies the
// fields the wire shape doesn't carry — `sortOrder` (computed via
// nextSortOrder, or copied from the existing row on update), `createdAt`
// (now for create, preserved on update), and `updatedAt` (always now).
export const wireToRecord = (
  wire: ModelAliasWireInput,
  meta: { sortOrder: number; createdAt: string; updatedAt: string },
): ModelAliasRecord => ({
  name: wire.name,
  kind: wire.kind,
  selection: wire.selection,
  displayName: wire.display_name,
  visibleInModelsList: wire.visible_in_models_list,
  targets: wire.targets,
  sortOrder: meta.sortOrder,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
});
