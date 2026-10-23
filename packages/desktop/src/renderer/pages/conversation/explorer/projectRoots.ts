/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maps the HTTP control-plane `ProjectDetailDto` (roots metadata) into the
 * projection layer's `RootRef[]`. Pure: no I/O, no React — so the display-title
 * fallback and status/role passthrough are unit-testable in isolation. The
 * backend already sorts `entries` by `order_index`; order is preserved here.
 */

import type { ProjectDetailDto, ProjectEntryDto } from '@/common/types/project';

import type { RootRef } from './explorerModel';

/** A raw UUID is an internal id, never a folder name shown to a person. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: string): boolean => UUID.test(value.trim());

const pathSegments = (displayPath: string): string[] => displayPath.split(/[\\/]+/).filter((part) => part.length > 0);

const visibleTitle = (entry: ProjectEntryDto): string => {
  const candidates = [entry.display_name?.trim() ?? '', ...pathSegments(entry.display_path).toReversed()];
  const human = candidates.find((part) => part.length > 0 && !isUuid(part));
  if (human) return human;
  return isUuid(entry.pe_id) ? '' : entry.pe_id;
};

/**
 * One entry → RootRef. Title precedence: a human `display_name` → the nearest
 * path segment that is not a UUID → `pe_id` when that id is not a UUID.
 * A raw UUID is never used as the visible folder name. `role` / `runtime_status`
 * pass through onto the root node for pinning + status display.
 */
export const entryToRootRef = (entry: ProjectEntryDto): RootRef => ({
  pe_id: entry.pe_id,
  title: visibleTitle(entry),
  role: entry.role,
  runtimeStatus: entry.runtime_status,
});

/** Full project detail → ordered pe roots for the projection. */
export const toRootRefs = (detail: ProjectDetailDto): RootRef[] => detail.explorer.entries.map(entryToRootRef);
