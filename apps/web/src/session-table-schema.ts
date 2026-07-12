import { rtkSavingsPct, usageRowCsvColumns } from '@ai-usage/report-core/csv';
import type { SortingState, VisibilityState } from '@tanstack/solid-table';
import type { DashboardRow } from './shared';

type SortValue = number | string;

interface SessionColumnSchemaEntry {
  defaultVisible?: boolean;
  hideable?: boolean;
  id: string;
  sortValue: (row: DashboardRow) => SortValue;
}

export const sessionColumnSchema = [
  { id: 'date', sortValue: (row) => row.sortDate },
  { id: 'session', hideable: false, sortValue: (row) => row.sortSession },
  { id: 'harness', sortValue: (row) => row.sortHarness },
  { id: 'machine', defaultVisible: false, sortValue: (row) => row.sortMachine },
  { id: 'provider', defaultVisible: false, sortValue: (row) => row.sortProvider },
  { id: 'project', sortValue: (row) => row.sortProject },
  { id: 'model', sortValue: (row) => row.sortModel },
  { id: 'tokIn', defaultVisible: false, sortValue: (row) => row.tokIn },
  { id: 'tokOut', defaultVisible: false, sortValue: (row) => row.tokOut },
  { id: 'cache', defaultVisible: false, sortValue: (row) => row.tokCr },
  { id: 'tokCw', defaultVisible: false, sortValue: (row) => row.tokCw },
  { id: 'fresh', defaultVisible: false, sortValue: (row) => row.freshTokens },
  { id: 'total', defaultVisible: false, sortValue: (row) => row.tokenTotal },
  { id: 'rtkSaved', defaultVisible: false, sortValue: (row) => rtkSavingsPct(row) ?? 0 },
  { id: 'cost', sortValue: (row) => (row.costKnown ? row.costApprox : Number.NEGATIVE_INFINITY) },
  {
    id: 'actual',
    defaultVisible: false,
    sortValue: (row) => row.costActual ?? Number.NEGATIVE_INFINITY,
  },
  { id: 'quota', defaultVisible: false, sortValue: (row) => row.costQuota ?? 0 },
  { id: 'duration', sortValue: (row) => row.durationMs ?? 0 },
  { id: 'calls', defaultVisible: false, sortValue: (row) => row.calls },
  { id: 'turns', defaultVisible: false, sortValue: (row) => row.turns },
  { id: 'tools', defaultVisible: false, sortValue: (row) => row.tools },
  { id: 'lines', defaultVisible: false, sortValue: (row) => row.lineDelta ?? 0 },
  { id: 'subagent', defaultVisible: false, sortValue: (row) => (row.subagent ? 1 : 0) },
  { id: 'partial', defaultVisible: false, sortValue: (row) => (row.partial ? 1 : 0) },
  {
    id: 'ambiguous',
    defaultVisible: false,
    sortValue: (row) => (row.ambiguous ? 1 : 0),
  },
] as const satisfies readonly SessionColumnSchemaEntry[];

export type SessionColumnId = (typeof sessionColumnSchema)[number]['id'];
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

export const sessionColumnIds: SessionColumnId[] = sessionColumnSchema.map((column) => column.id);
export const searchableColumnDiffIds = sessionColumnEntries.flatMap((column) =>
  column.hideable === false ? [] : [column.id as SearchableColumnDiffId],
);

const sessionColumnIdSet = new Set<string>(sessionColumnIds);
const searchableColumnDiffIdSet = new Set<string>(searchableColumnDiffIds);
const sessionColumnVisibilityBaseSet = new Set<string>(sessionColumnVisibilityBases);
const sessionColumnSchemaById = new Map(sessionColumnSchema.map((column) => [column.id, column]));

export const isSessionColumnId = (value: unknown): value is SessionColumnId =>
  typeof value === 'string' && sessionColumnIdSet.has(value);

export const isSearchableColumnDiffId = (value: unknown): value is SearchableColumnDiffId =>
  typeof value === 'string' && searchableColumnDiffIdSet.has(value);

export const isSessionColumnVisibilityBase = (value: unknown): value is SessionColumnVisibilityBase =>
  typeof value === 'string' && sessionColumnVisibilityBaseSet.has(value);

export const sortValueForSessionColumn = (row: DashboardRow, columnId: SessionColumnId): SortValue => {
  const column = sessionColumnSchemaById.get(columnId);
  if (!column) {
    throw new Error(`Unknown session column: ${columnId}`);
  }
  return column.sortValue(row);
};

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

export const sessionCsvColumns = usageRowCsvColumns;
