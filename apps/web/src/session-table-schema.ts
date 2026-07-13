import {
  isSessionSortField,
  type SessionSortField,
  sessionSortFields,
  sortValueForSessionColumn as sortValueForCoreSessionColumn,
} from '@ai-usage/report-core/session-query';
import type { SortingState, VisibilityState } from '@tanstack/solid-table';
import type { DashboardRow } from './shared';

export type SessionColumnId = SessionSortField;

interface SessionColumnSchemaEntry {
  defaultVisible?: boolean;
  hideable?: boolean;
  id: SessionColumnId;
}

export const sessionColumnSchema = [
  { id: 'date' },
  { id: 'session', hideable: false },
  { id: 'harness' },
  { id: 'machine', defaultVisible: false },
  { id: 'provider', defaultVisible: false },
  { id: 'project' },
  { id: 'model' },
  { id: 'tokIn', defaultVisible: false },
  { id: 'tokOut', defaultVisible: false },
  { id: 'cache', defaultVisible: false },
  { id: 'tokCw', defaultVisible: false },
  { id: 'fresh', defaultVisible: false },
  { id: 'total', defaultVisible: false },
  { id: 'rtkSaved', defaultVisible: false },
  { id: 'cost' },
  { id: 'actual', defaultVisible: false },
  { id: 'quota', defaultVisible: false },
  { id: 'duration' },
  { id: 'calls', defaultVisible: false },
  { id: 'turns', defaultVisible: false },
  { id: 'tools', defaultVisible: false },
  { id: 'lines', defaultVisible: false },
  { id: 'subagent', defaultVisible: false },
  { id: 'partial', defaultVisible: false },
  { id: 'ambiguous', defaultVisible: false },
] as const satisfies readonly SessionColumnSchemaEntry[];

export type SearchableColumnDiffId = Exclude<SessionColumnId, 'session'>;

export const sessionColumnVisibilityBases = ['auto', 'work', 'legacy'] as const;
export type SessionColumnVisibilityBase = (typeof sessionColumnVisibilityBases)[number];
type ExplicitSessionColumnVisibilityBase = Exclude<SessionColumnVisibilityBase, 'auto'>;

export interface SessionColumnVisibilitySearch {
  cols: SearchableColumnDiffId[];
  colsBase: SessionColumnVisibilityBase;
}

export const sessionColumnPresets = [
  {
    id: 'work',
    label: 'Work',
    visibleColumnIds: ['date', 'session', 'harness', 'project', 'model', 'cost', 'duration'],
  },
  {
    id: 'tokens',
    label: 'Tokens',
    visibleColumnIds: ['date', 'session', 'tokIn', 'tokOut', 'cache', 'fresh', 'rtkSaved'],
  },
  {
    id: 'reliability',
    label: 'Reliability',
    visibleColumnIds: ['date', 'session', 'harness', 'machine', 'provider', 'subagent', 'partial', 'ambiguous'],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  visibleColumnIds: readonly SessionColumnId[];
}[];

export type SessionColumnPresetId = (typeof sessionColumnPresets)[number]['id'];

const sessionColumnEntries: readonly SessionColumnSchemaEntry[] = sessionColumnSchema;
const legacyDefaultVisibleColumnIds = new Set<string>([
  'date',
  'session',
  'harness',
  'machine',
  'provider',
  'project',
  'model',
  'cache',
  'fresh',
  'rtkSaved',
  'cost',
  'duration',
]);

export const sessionColumnIds: SessionColumnId[] = [...sessionSortFields];
export const searchableColumnDiffIds = sessionColumnEntries.flatMap((column) =>
  column.hideable === false ? [] : [column.id as SearchableColumnDiffId],
);

const searchableColumnDiffIdSet = new Set<string>(searchableColumnDiffIds);
const sessionColumnVisibilityBaseSet = new Set<string>(sessionColumnVisibilityBases);

export const isSessionColumnId = isSessionSortField;

export const isSearchableColumnDiffId = (value: unknown): value is SearchableColumnDiffId =>
  typeof value === 'string' && searchableColumnDiffIdSet.has(value);

export const isSessionColumnVisibilityBase = (value: unknown): value is SessionColumnVisibilityBase =>
  typeof value === 'string' && sessionColumnVisibilityBaseSet.has(value);

export const sortValueForSessionColumn = (row: DashboardRow, columnId: SessionColumnId): number | string =>
  sortValueForCoreSessionColumn(row, columnId);

const hiddenColumnVisibility = (isHidden: (column: SessionColumnSchemaEntry) => boolean): VisibilityState => {
  const visibility: VisibilityState = {};
  for (const column of sessionColumnEntries) {
    if (isHidden(column)) {
      visibility[column.id] = false;
    }
  }
  return visibility;
};

export const defaultColumnVisibility = hiddenColumnVisibility((column) => column.defaultVisible === false);

const legacyDefaultColumnVisibility = hiddenColumnVisibility((column) => !legacyDefaultVisibleColumnIds.has(column.id));

export const isSessionColumnVisible = (visibility: VisibilityState, columnId: string) => visibility[columnId] !== false;

export const columnVisibilityForSessionPreset = (presetId: SessionColumnPresetId): VisibilityState => {
  const preset = sessionColumnPresets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Unknown session column preset: ${presetId}`);
  }
  const visibleColumnIds = new Set<string>(preset.visibleColumnIds);
  return Object.fromEntries(
    sessionColumnEntries
      .filter((column) => column.hideable !== false)
      .map((column) => [column.id, visibleColumnIds.has(column.id)]),
  );
};

export const sessionColumnPresetForVisibility = (visibility: VisibilityState): SessionColumnPresetId | null => {
  for (const preset of sessionColumnPresets) {
    const visibleColumnIds = new Set<string>(preset.visibleColumnIds);
    const matchesPreset = sessionColumnEntries.every(
      (column) => isSessionColumnVisible(visibility, column.id) === visibleColumnIds.has(column.id),
    );
    if (matchesPreset) {
      return preset.id;
    }
  }
  return null;
};

const resolvedColumnVisibilityBase = (
  columnDiff: SearchableColumnDiffId[],
  requestedBase?: SessionColumnVisibilityBase,
): ExplicitSessionColumnVisibilityBase => {
  if (requestedBase && requestedBase !== 'auto') {
    return requestedBase;
  }
  return columnDiff.length === 0 ? 'work' : 'legacy';
};

export const columnVisibilityFromDiff = (
  columnDiff: SearchableColumnDiffId[],
  requestedBase?: SessionColumnVisibilityBase,
): VisibilityState => {
  // Unversioned non-empty links were encoded against the former wide default.
  // Unversioned empty links intentionally migrate to the focused Work preset.
  const base = resolvedColumnVisibilityBase(columnDiff, requestedBase);
  const baseline = base === 'work' ? defaultColumnVisibility : legacyDefaultColumnVisibility;
  const visibility = { ...baseline };
  for (const columnId of columnDiff) {
    visibility[columnId] = baseline[columnId] === false;
  }
  return visibility;
};

export const columnDiffFromVisibility = (
  visibility: VisibilityState,
  base: ExplicitSessionColumnVisibilityBase,
): SearchableColumnDiffId[] => {
  const baseline = base === 'work' ? defaultColumnVisibility : legacyDefaultColumnVisibility;
  return searchableColumnDiffIds.flatMap((columnId) => {
    const defaultVisible = isSessionColumnVisible(baseline, columnId);
    const currentVisible = isSessionColumnVisible(visibility, columnId);
    return defaultVisible === currentVisible ? [] : [columnId];
  });
};

export const columnVisibilitySearchForVisibility = (visibility: VisibilityState): SessionColumnVisibilitySearch => {
  const workDiff = columnDiffFromVisibility(visibility, 'work');
  if (workDiff.length === 0) {
    return { cols: [], colsBase: 'auto' };
  }
  const legacyDiff = columnDiffFromVisibility(visibility, 'legacy');
  return workDiff.length < legacyDiff.length
    ? { cols: workDiff, colsBase: 'work' }
    : { cols: legacyDiff, colsBase: 'legacy' };
};

export const sortFromSortingState = (sorting: SortingState, fallbackSort: { id: SessionColumnId; desc: boolean }) => {
  const sort = sorting[0];
  if (!(sort && isSessionColumnId(sort.id))) {
    return fallbackSort;
  }
  return { id: sort.id, desc: sort.desc };
};
