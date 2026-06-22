import {
  CellWithProvenance,
  dateCell,
  filterTextButton,
  modelCell,
  muted,
  numCell,
  ProvenanceMarker,
  right,
  sessionCell,
  sessionTitleClamp,
} from '@ai-usage/design-system/report';
import { provenanceForMetric, type UsageMetricKey } from '@ai-usage/report-core/provenance';
import type { ColumnDef, RowData, VisibilityState } from '@tanstack/solid-table';
import { type JSX, Show } from 'solid-js';
import { campaignBadgeLabelForRow } from './dashboard-model';
import type { FieldFilterKey } from './dashboard-search';
import { lineDeltaLabel, rtkSavedLabel, rtkSavedTitle, rtkSavingsPct, sortValueForRow } from './dashboard-sort';
import { HighlightedText } from './highlighted-text';
import type { SessionColumnId } from './session-table-schema';
import { isSessionColumnVisible as isSessionColumnVisibleForSchema } from './session-table-schema';
import {
  type DashboardRow,
  fmtCompact,
  fmtDate,
  fmtDuration,
  fmtMoney,
  fmtNum,
  HarnessBadge,
  UNKNOWN_PRICE_HINT,
  UsageUnavailableCell,
} from './shared';

declare module '@tanstack/solid-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    cellClass?: string;
    defaultVisible?: boolean;
    headerClass?: string;
    label: string;
    title?: string;
    widthPx: number;
  }

  interface TableMeta<TData extends RowData> {
    onFieldFilter?: (key: FieldFilterKey, value: string) => void;
    onHarnessFilter?: (value: string) => void;
    searchQuery?: string;
  }
}

export type SessionColumnDef = ColumnDef<DashboardRow> & { id: SessionColumnId };

const provenanceFacts = (row: DashboardRow, metric: UsageMetricKey) => provenanceForMetric(row, metric);
const withProvenance = (row: DashboardRow, metric: UsageMetricKey, value: string | JSX.Element) => (
  <CellWithProvenance facts={provenanceFacts(row, metric)}>{value}</CellWithProvenance>
);
const tokenCell = (row: DashboardRow, value: number) =>
  withProvenance(row, 'tokens', row.usageUnavailable ? <UsageUnavailableCell /> : fmtCompact(value));
const countCell = (row: DashboardRow, value: number, metric: UsageMetricKey) =>
  withProvenance(row, metric, row.usageUnavailable ? <UsageUnavailableCell /> : fmtNum(value));

export const sessionColumns: SessionColumnDef[] = [
  {
    id: 'date',
    header: 'Date',
    accessorFn: (row) => sortValueForRow(row, 'date'),
    cell: (info) => fmtDate(info.row.original.activeDate),
    sortDescFirst: true,
    meta: { label: 'Date', widthPx: 104, cellClass: dateCell },
  },
  {
    id: 'harness',
    header: 'Harness',
    accessorFn: (row) => sortValueForRow(row, 'harness'),
    cell: (info) => (
      <HarnessBadge
        name={info.row.original.harness}
        onClick={() => info.table.options.meta?.onHarnessFilter?.(info.row.original.harness)}
      />
    ),
    meta: { label: 'Harness', widthPx: 100 },
  },
  {
    id: 'machine',
    header: 'Machine',
    accessorFn: (row) => sortValueForRow(row, 'machine'),
    cell: (info) => info.row.original.source?.machineLabel || '—',
    meta: { label: 'Machine', widthPx: 120 },
  },
  {
    id: 'provider',
    header: 'Provider',
    accessorFn: (row) => sortValueForRow(row, 'provider'),
    cell: (info) => {
      const row = info.row.original;
      const label = row.providerDisplay;
      return (
        <button
          class={filterTextButton}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('provider', label);
          }}
          title={`Filter by ${label}`}
          type="button"
        >
          {label}
        </button>
      );
    },
    meta: { label: 'Provider', widthPx: 124 },
  },
  {
    id: 'model',
    header: 'Model',
    accessorFn: (row) => sortValueForRow(row, 'model'),
    cell: (info) => {
      const row = info.row.original;
      return (
        <button
          class={filterTextButton}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('model', row.modelKey);
          }}
          title={`Filter by ${row.modelKey}`}
          type="button"
        >
          {row.modelLabel}
        </button>
      );
    },
    meta: { label: 'Model', widthPx: 168, cellClass: modelCell },
  },
  {
    id: 'project',
    header: 'Project',
    accessorFn: (row) => sortValueForRow(row, 'project'),
    cell: (info) => {
      const row = info.row.original;
      const label = row.projectKey;
      return (
        <button
          class={filterTextButton}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('project', label);
          }}
          title={`Filter by ${label}`}
          type="button"
        >
          {row.project || '—'}
        </button>
      );
    },
    meta: { label: 'Project', widthPx: 120 },
  },
  {
    id: 'tokIn',
    header: 'Input',
    accessorFn: (row) => row.tokIn,
    cell: (info) => tokenCell(info.row.original, info.row.original.tokIn),
    sortDescFirst: true,
    meta: { label: 'Input tokens', widthPx: 90, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'tokOut',
    header: 'Output',
    accessorFn: (row) => row.tokOut,
    cell: (info) => tokenCell(info.row.original, info.row.original.tokOut),
    sortDescFirst: true,
    meta: { label: 'Output tokens', widthPx: 94, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'cache',
    header: 'Cache',
    accessorFn: (row) => row.tokCr,
    cell: (info) => tokenCell(info.row.original, info.row.original.tokCr),
    sortDescFirst: true,
    meta: {
      label: 'Cache read',
      title: 'Cache-read tokens',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'tokCw',
    header: 'Write',
    accessorFn: (row) => row.tokCw,
    cell: (info) => tokenCell(info.row.original, info.row.original.tokCw),
    sortDescFirst: true,
    meta: {
      label: 'Cache write',
      title: 'Cache-write tokens',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
      defaultVisible: false,
    },
  },
  {
    id: 'fresh',
    header: 'Fresh',
    accessorFn: (row) => row.freshTokens,
    cell: (info) => tokenCell(info.row.original, info.row.original.freshTokens),
    sortDescFirst: true,
    meta: {
      label: 'Fresh tokens',
      title: 'Tokens processed without cache (input + output + cache writes)',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'total',
    header: 'Total',
    accessorFn: (row) => row.tokenTotal,
    cell: (info) => tokenCell(info.row.original, info.row.original.tokenTotal),
    sortDescFirst: true,
    meta: { label: 'Total tokens', widthPx: 90, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'rtkSaved',
    header: 'RTK',
    accessorFn: (row) => rtkSavingsPct(row) ?? 0,
    cell: (info) => <span title={rtkSavedTitle(info.row.original)}>{rtkSavedLabel(info.row.original)}</span>,
    sortDescFirst: true,
    meta: {
      label: 'RTK savings',
      title: 'RTK saved-token percentage; hover a cell for matched command details',
      widthPx: 86,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'cost',
    header: '$API',
    accessorFn: (row) => sortValueForRow(row, 'cost'),
    cell: (info) => {
      const row = info.row.original;
      return withProvenance(
        row,
        'api-value',
        <Show fallback={<UsageUnavailableCell />} when={!row.usageUnavailable}>
          <Show fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>} when={row.costKnown}>
            {fmtMoney(row.costApprox)}
          </Show>
        </Show>,
      );
    },
    sortDescFirst: true,
    meta: {
      label: 'API value',
      title: 'Estimated cost at standard API prices',
      widthPx: 76,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'actual',
    header: '$Actual',
    accessorFn: (row) => sortValueForRow(row, 'actual'),
    cell: (info) => {
      const row = info.row.original;
      return withProvenance(
        row,
        'actual-cost',
        row.usageUnavailable ? <UsageUnavailableCell /> : fmtMoney(row.costActual),
      );
    },
    sortDescFirst: true,
    meta: {
      label: 'Actual cost',
      title: 'Out-of-pocket spend reported by harnesses',
      widthPx: 88,
      cellClass: numCell,
      headerClass: right,
      defaultVisible: false,
    },
  },
  {
    id: 'quota',
    header: '$Sub',
    accessorFn: (row) => sortValueForRow(row, 'quota'),
    cell: (info) => {
      const row = info.row.original;
      return withProvenance(
        row,
        'subscription-value',
        row.usageUnavailable ? <UsageUnavailableCell /> : fmtMoney(row.costQuota ?? null),
      );
    },
    sortDescFirst: true,
    meta: {
      label: 'Subscription value',
      title: 'Cursor export value covered by the subscription quota',
      widthPx: 86,
      cellClass: numCell,
      headerClass: right,
      defaultVisible: false,
    },
  },
  {
    id: 'duration',
    header: 'Span',
    accessorFn: (row) => row.durationMs ?? 0,
    cell: (info) => fmtDuration(info.row.original.durationMs),
    sortDescFirst: true,
    meta: {
      label: 'Duration',
      title: 'Wall-clock session duration',
      widthPx: 68,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'calls',
    header: 'Calls',
    accessorFn: (row) => row.calls,
    cell: (info) => countCell(info.row.original, info.row.original.calls, 'calls'),
    sortDescFirst: true,
    meta: { label: 'Calls', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'turns',
    header: 'Turns',
    accessorFn: (row) => row.turns,
    cell: (info) => withProvenance(info.row.original, 'turns', fmtNum(info.row.original.turns)),
    sortDescFirst: true,
    meta: { label: 'Turns', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'tools',
    header: 'Tools',
    accessorFn: (row) => row.tools,
    cell: (info) => countCell(info.row.original, info.row.original.tools, 'tools'),
    sortDescFirst: true,
    meta: { label: 'Tools', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'lines',
    header: 'Lines',
    accessorFn: (row) => row.lineDelta ?? 0,
    cell: (info) => withProvenance(info.row.original, 'lines', lineDeltaLabel(info.row.original)),
    sortDescFirst: true,
    meta: { label: 'Lines changed', widthPx: 96, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'subagent',
    header: 'Sub',
    accessorFn: (row) => (row.subagent ? 1 : 0),
    cell: (info) => (info.row.original.subagent ? 'Yes' : 'No'),
    sortDescFirst: true,
    meta: { label: 'Subagent', widthPx: 72, defaultVisible: false },
  },
  {
    id: 'partial',
    header: 'Partial',
    accessorFn: (row) => (row.partial ? 1 : 0),
    cell: (info) => (info.row.original.partial ? 'Yes' : 'No'),
    sortDescFirst: true,
    meta: { label: 'Partial', widthPx: 82, defaultVisible: false },
  },
  {
    id: 'ambiguous',
    header: 'Ambig',
    accessorFn: (row) => (row.ambiguous ? 1 : 0),
    cell: (info) => (info.row.original.ambiguous ? 'Yes' : 'No'),
    sortDescFirst: true,
    meta: { label: 'Ambiguous reconciliation', widthPx: 92, defaultVisible: false },
  },
  {
    id: 'session',
    header: 'Session',
    accessorFn: (row) => row.sessionLabel.toLowerCase(),
    cell: (info) => {
      const campaignLabel = () => campaignBadgeLabelForRow(info.row.original);
      const titleFacts = () => provenanceFacts(info.row.original, 'title');
      return (
        <div class={sessionTitleClamp} style={{ 'padding-left': `${info.row.depth * 14}px` }}>
          <Show when={info.row.getCanExpand()}>
            <button
              class={filterTextButton}
              onClick={(event) => {
                event.stopPropagation();
                info.row.toggleExpanded();
              }}
              title={info.row.getIsExpanded() ? 'Collapse campaign' : 'Expand campaign'}
              type="button"
            >
              {info.row.getIsExpanded() ? '▾' : '▸'}
            </button>
          </Show>
          <HighlightedText query={info.table.options.meta?.searchQuery ?? ''} text={info.row.original.sessionLabel} />
          <ProvenanceMarker facts={titleFacts()} />
          <Show when={campaignLabel()}>
            {(label) => (
              <span class={muted} title={label()}>
                {' '}
                {label()}
              </span>
            )}
          </Show>
        </div>
      );
    },
    enableHiding: false,
    meta: { label: 'Session', widthPx: 300, cellClass: sessionCell },
  },
];

export { defaultColumnVisibility, isSessionColumnVisible } from './session-table-schema';

export const visibleSessionColumns = (visibility: VisibilityState) =>
  sessionColumns.filter((column) => isSessionColumnVisibleForSchema(visibility, column.id));

export const sessionColumnLabel = (column: SessionColumnDef) => column.meta?.label ?? column.id;

export const sessionColumnHeader = (column: SessionColumnDef) =>
  typeof column.header === 'string' ? column.header : sessionColumnLabel(column);
