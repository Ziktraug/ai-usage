import { rtkSavingsPct, usageRowCsvColumns } from '@ai-usage/report-core/csv';
import type { SortingState, VisibilityState } from '@tanstack/solid-table';
import type { DashboardRow } from './shared';

type SortValue = number | string;

interface SessionColumnSchemaEntry {
  defaultVisible?: boolean;
  hideable?: boolean;
  id: string;
  label: string;
  sortValue: (row: DashboardRow) => SortValue;
}

export const sessionColumnSchema = [
  { id: 'date', label: 'Date', sortValue: (row) => row.sortDate },
  { id: 'session', label: 'Session', hideable: false, sortValue: (row) => row.sortSession },
  { id: 'harness', label: 'Harness', sortValue: (row) => row.sortHarness },
  { id: 'machine', label: 'Machine', defaultVisible: false, sortValue: (row) => row.sortMachine },
  { id: 'provider', label: 'Provider', defaultVisible: false, sortValue: (row) => row.sortProvider },
  { id: 'project', label: 'Project', sortValue: (row) => row.sortProject },
  { id: 'model', label: 'Model', sortValue: (row) => row.sortModel },
  { id: 'tokIn', label: 'Input tokens', defaultVisible: false, sortValue: (row) => row.tokIn },
  { id: 'tokOut', label: 'Output tokens', defaultVisible: false, sortValue: (row) => row.tokOut },
  { id: 'cache', label: 'Cache read', defaultVisible: false, sortValue: (row) => row.tokCr },
  { id: 'tokCw', label: 'Cache write', defaultVisible: false, sortValue: (row) => row.tokCw },
  { id: 'fresh', label: 'Fresh tokens', defaultVisible: false, sortValue: (row) => row.freshTokens },
  { id: 'total', label: 'Total tokens', defaultVisible: false, sortValue: (row) => row.tokenTotal },
  { id: 'rtkSaved', label: 'RTK savings', defaultVisible: false, sortValue: (row) => rtkSavingsPct(row) ?? 0 },
  { id: 'cost', label: 'API value', sortValue: (row) => (row.costKnown ? row.costApprox : Number.NEGATIVE_INFINITY) },
  {
    id: 'actual',
    label: 'Actual cost',
    defaultVisible: false,
    sortValue: (row) => row.costActual ?? Number.NEGATIVE_INFINITY,
  },
  { id: 'quota', label: 'Subscription value', defaultVisible: false, sortValue: (row) => row.costQuota ?? 0 },
  { id: 'duration', label: 'Duration', sortValue: (row) => row.durationMs ?? 0 },
  { id: 'calls', label: 'Calls', defaultVisible: false, sortValue: (row) => row.calls },
  { id: 'turns', label: 'Turns', defaultVisible: false, sortValue: (row) => row.turns },
  { id: 'tools', label: 'Tools', defaultVisible: false, sortValue: (row) => row.tools },
  { id: 'lines', label: 'Lines changed', defaultVisible: false, sortValue: (row) => row.lineDelta ?? 0 },
  { id: 'subagent', label: 'Subagent', defaultVisible: false, sortValue: (row) => (row.subagent ? 1 : 0) },
  { id: 'partial', label: 'Partial', defaultVisible: false, sortValue: (row) => (row.partial ? 1 : 0) },
  {
    id: 'ambiguous',
    label: 'Ambiguous reconciliation',
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

export const sessionColumnIds = sessionColumnSchema.map((column) => column.id) as SessionColumnId[];
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

export const defaultColumnVisibility = Object.fromEntries(
  sessionColumnEntries.filter((column) => column.defaultVisible === false).map((column) => [column.id, false]),
) as VisibilityState;

const legacyDefaultColumnVisibility = Object.fromEntries(
  sessionColumnEntries
    .filter((column) => !legacyDefaultVisibleColumnIds.has(column.id))
    .map((column) => [column.id, false]),
) as VisibilityState;

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
