// Snake_case wire ↔ camelCase record conversion for model aliases. The wire
// shape (`ModelAlias`) lives in `@floway-dev/protocols/common`.

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

// Wire payload accepted by the create / update body schemas. `sort_order` is
// optional; everything else is required.
export interface ModelAliasWireInput {
  name: string;
  kind: AliasKind;
  selection: AliasSelection;
  display_name: string | null;
  visible_in_models_list: boolean;
  targets: AliasTarget[];
  sort_order?: number;
}

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
