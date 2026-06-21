import type { SerializedRow } from '@ai-usage/report-core/report-data';
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

const rtkSavingsPct = (row: Pick<SerializedRow, 'rtkInputTokens' | 'rtkSavedTokens'>) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;

export const sessionColumnSchema = [
  { id: 'date', label: 'Date', sortValue: (row) => row.sortDate },
  { id: 'harness', label: 'Harness', sortValue: (row) => row.sortHarness },
  { id: 'machine', label: 'Machine', sortValue: (row) => row.sortMachine },
  { id: 'provider', label: 'Provider', sortValue: (row) => row.sortProvider },
  { id: 'model', label: 'Model', sortValue: (row) => row.sortModel },
  { id: 'project', label: 'Project', sortValue: (row) => row.sortProject },
  { id: 'tokIn', label: 'Input tokens', defaultVisible: false, sortValue: (row) => row.tokIn },
  { id: 'tokOut', label: 'Output tokens', defaultVisible: false, sortValue: (row) => row.tokOut },
  { id: 'cache', label: 'Cache read', sortValue: (row) => row.tokCr },
  { id: 'tokCw', label: 'Cache write', defaultVisible: false, sortValue: (row) => row.tokCw },
  { id: 'fresh', label: 'Fresh tokens', sortValue: (row) => row.freshTokens },
  { id: 'total', label: 'Total tokens', defaultVisible: false, sortValue: (row) => row.tokenTotal },
  { id: 'rtkSaved', label: 'RTK savings', sortValue: (row) => rtkSavingsPct(row) ?? 0 },
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
  { id: 'session', label: 'Session', hideable: false, sortValue: (row) => row.sortSession },
] as const satisfies readonly SessionColumnSchemaEntry[];

export type SessionColumnId = (typeof sessionColumnSchema)[number]['id'];
export type SearchableColumnDiffId = Exclude<SessionColumnId, 'session'>;

const sessionColumnEntries: readonly SessionColumnSchemaEntry[] = sessionColumnSchema;

export const sessionColumnIds = sessionColumnSchema.map((column) => column.id) as SessionColumnId[];
export const searchableColumnDiffIds = sessionColumnEntries.flatMap((column) =>
  column.hideable === false ? [] : [column.id as SearchableColumnDiffId],
);

const sessionColumnIdSet = new Set<string>(sessionColumnIds);
const searchableColumnDiffIdSet = new Set<string>(searchableColumnDiffIds);
const sessionColumnSchemaById = new Map(sessionColumnSchema.map((column) => [column.id, column]));

export const isSessionColumnId = (value: unknown): value is SessionColumnId =>
  typeof value === 'string' && sessionColumnIdSet.has(value);

export const isSearchableColumnDiffId = (value: unknown): value is SearchableColumnDiffId =>
  typeof value === 'string' && searchableColumnDiffIdSet.has(value);

export const sortValueForSessionColumn = (row: DashboardRow, columnId: SessionColumnId): SortValue => {
  const column = sessionColumnSchemaById.get(columnId);
  if (!column) throw new Error(`Unknown session column: ${columnId}`);
  return column.sortValue(row);
};

export const defaultColumnVisibility = Object.fromEntries(
  sessionColumnEntries.filter((column) => column.defaultVisible === false).map((column) => [column.id, false]),
) as VisibilityState;

export const isSessionColumnVisible = (visibility: VisibilityState, columnId: string) => visibility[columnId] !== false;

export const columnVisibilityFromDiff = (columnDiff: SearchableColumnDiffId[]): VisibilityState => {
  const visibility = { ...defaultColumnVisibility };
  for (const columnId of columnDiff) {
    visibility[columnId] = defaultColumnVisibility[columnId] === false;
  }
  return visibility;
};

export const columnDiffFromVisibility = (visibility: VisibilityState): SearchableColumnDiffId[] =>
  searchableColumnDiffIds.flatMap((columnId) => {
    const defaultVisible = isSessionColumnVisible(defaultColumnVisibility, columnId);
    const currentVisible = isSessionColumnVisible(visibility, columnId);
    return defaultVisible === currentVisible ? [] : [columnId];
  });

export const sortFromSortingState = (sorting: SortingState, fallbackSort: { id: SessionColumnId; desc: boolean }) => {
  const sort = sorting[0];
  if (!sort || !isSessionColumnId(sort.id)) return fallbackSort;
  return { id: sort.id, desc: sort.desc };
};

export const sessionCsvColumns = [
  { header: 'date', value: (row) => row.date },
  { header: 'end_date', value: (row) => row.endDate },
  { header: 'active_date', value: (row) => row.activeDate },
  { header: 'harness', value: (row) => row.harness },
  { header: 'machine', value: (row) => row.source?.machineLabel },
  { header: 'machine_id', value: (row) => row.source?.machineId },
  { header: 'provider', value: (row) => row.provider },
  { header: 'session', value: (row) => row.name },
  { header: 'model', value: (row) => row.model },
  { header: 'models', value: (row) => row.models?.join('|') },
  { header: 'project', value: (row) => row.project },
  { header: 'input', value: (row) => row.tokIn },
  { header: 'output', value: (row) => row.tokOut },
  { header: 'cache_read', value: (row) => row.tokCr },
  { header: 'cache_write', value: (row) => row.tokCw },
  { header: 'fresh_tokens', value: (row) => row.freshTokens },
  { header: 'total_tokens', value: (row) => row.tokenTotal },
  { header: 'cost_actual', value: (row) => row.costActual },
  { header: 'cost_quota', value: (row) => row.costQuota },
  { header: 'cost_approx_api', value: (row) => row.costApprox.toFixed(4) },
  { header: 'cost_known', value: (row) => row.costKnown },
  { header: 'calls', value: (row) => row.calls },
  { header: 'duration_ms', value: (row) => row.durationMs },
  { header: 'turns', value: (row) => row.turns },
  { header: 'tools', value: (row) => row.tools },
  { header: 'lines_added', value: (row) => row.linesAdded },
  { header: 'lines_deleted', value: (row) => row.linesDeleted },
  { header: 'line_delta', value: (row) => row.lineDelta },
  { header: 'rtk_saved_tokens', value: (row) => row.rtkSavedTokens },
  { header: 'rtk_input_tokens', value: (row) => row.rtkInputTokens },
  { header: 'rtk_output_tokens', value: (row) => row.rtkOutputTokens },
  { header: 'rtk_savings_pct', value: (row) => rtkSavingsPct(row)?.toFixed(2) },
  { header: 'rtk_command_count', value: (row) => row.rtkCommandCount },
  { header: 'subagent', value: (row) => row.subagent ?? false },
  { header: 'partial', value: (row) => row.partial ?? false },
  { header: 'usage_unavailable', value: (row) => row.usageUnavailable ?? false },
  { header: 'ambiguous', value: (row) => row.ambiguous ?? false },
] as const satisfies readonly { header: string; value: (row: SerializedRow) => unknown }[];
