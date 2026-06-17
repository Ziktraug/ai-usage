import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { UsageReportPayload } from '@ai-usage/core/report-data';
import {
  activeFilters,
  barFill,
  barTrack,
  chartLegend,
  columnToggle,
  columnToggleInput,
  columnToggleText,
  commandButton,
  dateCell,
  dateEditRow,
  dateFieldGroup,
  dateInput,
  demoBadge,
  detailItem,
  detailLabel,
  detailValue,
  drawer,
  drawerActions,
  drawerBody,
  drawerClose,
  drawerCompare,
  drawerGrid,
  drawerLegend,
  drawerLegendItem,
  drawerLegendSwatch,
  drawerLegendValue,
  drawerNav,
  drawerPosition,
  drawerTitle,
  drawerTop,
  empty,
  emptyActions,
  eyebrow,
  eyebrowRow,
  filterSummary,
  filterTextButton,
  ghostButton,
  groupCount,
  groupHeader,
  groupKeyButton,
  groupPanel,
  groupPct,
  groupRow,
  groupRows,
  groupSub,
  groupTitle,
  groupValue,
  header,
  headerTop,
  inlineFieldLabel,
  meta,
  metricGrid,
  modelCell,
  monthGridline,
  muted,
  numCell,
  page,
  popoverContent,
  popoverGrid,
  popoverHeader,
  presetButton,
  presetGroup,
  projectTable,
  refreshButton,
  refreshIconButton,
  refreshRing,
  refreshRingDelayed,
  refreshRingError,
  refreshRingIdle,
  refreshRingPaused,
  refreshRingRefreshing,
  refreshRingStatic,
  refreshRingSuccess,
  refreshStatus,
  refreshStatusError,
  right,
  searchInput,
  section,
  selectInput,
  sessionCell,
  sessionsTable,
  sessionTitleClamp,
  shell,
  sortArrow,
  sortButton,
  strongCell,
  summaryPill,
  table,
  tableControls,
  tableWrap,
  tabsList,
  tabsRoot,
  tabTrigger,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timeRangeHeader,
  timeRangeMeta,
  timeRangePanel,
  timeRangeTitle,
  timeSliderBars,
  timeSliderControl,
  timeSliderDimLeft,
  timeSliderDimRight,
  timeSliderRange,
  timeSliderRangeDrag,
  timeSliderRoot,
  timeSliderThumb,
  timeSliderTrack,
  title,
  titleBlock,
  toolbar,
  tooltipContent,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import { Popover } from '@ark-ui/solid/popover';
import { Slider } from '@ark-ui/solid/slider';
import { Tabs } from '@ark-ui/solid/tabs';
import { Tooltip } from '@ark-ui/solid/tooltip';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import {
  type Column,
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type RowData,
  type SortingState,
  type Updater,
  type VisibilityState,
} from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { downloadCSV, downloadHTML } from './dashboard-export';
import { createFilterSnapshot, FilterPill, fieldFilterLabels, matchesFilterSnapshot } from './dashboard-filters';
import { type Metric, type MetricDelta, MetricTile } from './dashboard-metrics';
import {
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  type FieldFilterKey,
  type FieldFilters,
  isDashboardTab,
  isSessionColumnId,
  type SearchableColumnDiffId,
  type SessionColumnId,
  sortingStateFromSearch,
} from './dashboard-search';
import {
  compareRows,
  lineDeltaLabel,
  rtkSavedLabel,
  rtkSavedTitle,
  rtkSavingsPct,
  sortValueForRow,
} from './dashboard-sort';
import { ThemeToggle } from './dashboard-theme';
import {
  clampNumber,
  DAY_MS,
  type DateBounds,
  dateFromIndex,
  dateIndexFrom,
  dateRangePresets,
  endOfDay,
  normalizeDateIndexRange,
  rowMatchesDateBounds,
  rowTime,
  shiftCalendarDays,
  startOfDay,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';
import { createDateRangeController, type DateRangeController } from './date-range-controller';
import { HighlightedText } from './highlighted-text';
import { Overview } from './Overview';
import {
  type CursorCommitAttributionFacet,
  cursorCommitAttributionFacet,
  fetchReportPayload,
  isDemoReportPayload,
  readReportPayload,
} from './report-data';
import {
  accentFill,
  buildReportSummary,
  type DashboardRow,
  enrichReportRow,
  fmtCompact,
  fmtDate,
  fmtDateOnly,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  HarnessBadge,
  harnessFillFor,
  median,
  rowKey,
  SegmentBar,
  tokenSegmentClasses,
  UNKNOWN_PRICE_HINT,
  USAGE_UNAVAILABLE_HINT,
  UsageUnavailableCell,
} from './shared';
import { applyTableUpdate } from './table-utils';

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

const initialPayload = readReportPayload();
const REFRESH_INTERVAL_MS = 60_000;

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
type ProjectGroup = {
  key: string;
  sessions: number;
  fresh: number;
  cache: number;
  cost: number;
  priced: number;
  turns: number;
  tools: number;
  linesAdded: number;
  linesDeleted: number;
};
type MutableAnalyticsGroup = AnalyticsGroup & { costs: number[] };

type SessionColumnDef = ColumnDef<DashboardRow> & { id: SessionColumnId };

const tokenCell = (row: DashboardRow, value: number) =>
  row.usageUnavailable ? <UsageUnavailableCell /> : fmtCompact(value);
const countCell = (row: DashboardRow, value: number) =>
  row.usageUnavailable ? <UsageUnavailableCell /> : fmtNum(value);

const sessionColumns: SessionColumnDef[] = [
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
          type="button"
          title={`Filter by ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('provider', label);
          }}
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
          type="button"
          title={`Filter by ${row.modelKey}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('model', row.modelKey);
          }}
        >
          {row.model}
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
          type="button"
          title={`Filter by ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('project', label);
          }}
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
    cell: (info) => (
      <Show when={!info.row.original.usageUnavailable} fallback={<UsageUnavailableCell />}>
        <Show when={info.row.original.costKnown} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
          {fmtMoney(info.row.original.costApprox)}
        </Show>
      </Show>
    ),
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
    cell: (info) =>
      info.row.original.usageUnavailable ? <UsageUnavailableCell /> : fmtMoney(info.row.original.costActual),
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
    cell: (info) => countCell(info.row.original, info.row.original.calls),
    sortDescFirst: true,
    meta: { label: 'Calls', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'turns',
    header: 'Turns',
    accessorFn: (row) => row.turns,
    cell: (info) => fmtNum(info.row.original.turns),
    sortDescFirst: true,
    meta: { label: 'Turns', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'tools',
    header: 'Tools',
    accessorFn: (row) => row.tools,
    cell: (info) => countCell(info.row.original, info.row.original.tools),
    sortDescFirst: true,
    meta: { label: 'Tools', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'lines',
    header: 'Lines',
    accessorFn: (row) => row.lineDelta ?? 0,
    cell: (info) => lineDeltaLabel(info.row.original),
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
    id: 'session',
    header: 'Session',
    accessorFn: (row) => row.sessionLabel.toLowerCase(),
    cell: (info) => (
      <div class={sessionTitleClamp}>
        <HighlightedText text={info.row.original.sessionLabel} query={info.table.options.meta?.searchQuery ?? ''} />
      </div>
    ),
    enableHiding: false,
    meta: { label: 'Session', widthPx: 300, cellClass: sessionCell },
  },
];

const defaultColumnVisibility = Object.fromEntries(
  sessionColumns.filter((column) => column.meta?.defaultVisible === false).map((column) => [column.id, false]),
) as VisibilityState;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);

const isSessionColumnVisible = (visibility: VisibilityState, columnId: string) => visibility[columnId] !== false;

const visibleSessionColumns = (visibility: VisibilityState) =>
  sessionColumns.filter((column) => isSessionColumnVisible(visibility, column.id));

const columnVisibilityFromDiff = (columnDiff: SearchableColumnDiffId[]): VisibilityState => {
  const visibility = { ...defaultColumnVisibility };
  for (const columnId of columnDiff) {
    visibility[columnId] = defaultColumnVisibility[columnId] === false;
  }
  return visibility;
};

const columnDiffFromVisibility = (visibility: VisibilityState): SearchableColumnDiffId[] =>
  sessionColumns.flatMap((column) => {
    if (column.enableHiding === false) return [];
    const defaultVisible = isSessionColumnVisible(defaultColumnVisibility, column.id);
    const currentVisible = isSessionColumnVisible(visibility, column.id);
    return defaultVisible === currentVisible ? [] : [column.id as SearchableColumnDiffId];
  });

const sortFromSortingState = (sorting: SortingState) => {
  const sort = sorting[0];
  if (!sort || !isSessionColumnId(sort.id)) return dashboardSearchDefaults.sort;
  return { id: sort.id, desc: sort.desc };
};

const sessionColumnLabel = (column: SessionColumnDef) => column.meta?.label ?? column.id;

const sessionColumnHeader = (column: SessionColumnDef) =>
  typeof column.header === 'string' ? column.header : sessionColumnLabel(column);

const createAnalyticsGroup = (key: string, row: DashboardRow): MutableAnalyticsGroup => ({
  key,
  harness: row.harness,
  provider: row.provider,
  sessions: 0,
  priced: 0,
  unpriced: 0,
  usageUnavailable: 0,
  fresh: 0,
  inp: 0,
  cache: 0,
  cacheHitPct: 0,
  costSum: 0,
  costPerSession: null,
  medianCost: null,
  linesA: 0,
  linesD: 0,
  lineCount: 0,
  costPer100Lines: null,
  costPercent: 0,
  turns: 0,
  tools: 0,
  costs: [],
});

const addAnalyticsRow = (groups: Map<string, MutableAnalyticsGroup>, key: string, row: DashboardRow) => {
  let group = groups.get(key);
  if (!group) {
    group = createAnalyticsGroup(key, row);
    groups.set(key, group);
  }

  group.sessions++;
  if (row.usageUnavailable) group.usageUnavailable++;
  group.fresh += row.freshTokens;
  group.inp += row.tokIn;
  group.cache += row.tokCr;
  group.linesA += row.linesAdded ?? 0;
  group.linesD += row.linesDeleted ?? 0;
  group.turns += row.turns;
  group.tools += row.tools;
  if (row.costKnown) {
    group.priced++;
    group.costSum += row.costApprox;
    group.costs.push(row.costApprox);
  } else {
    group.unpriced++;
  }
};

const finalizeAnalyticsGroups = (groups: Map<string, MutableAnalyticsGroup>, totalCost: number): AnalyticsGroup[] =>
  [...groups.values()]
    .map((group) => {
      const lineCount = group.linesA + group.linesD;
      return {
        ...group,
        cacheHitPct: group.inp + group.cache > 0 ? (group.cache / (group.inp + group.cache)) * 100 : 0,
        costPerSession: group.priced ? group.costSum / group.priced : null,
        medianCost: group.priced ? median(group.costs) : null,
        lineCount,
        costPer100Lines: lineCount && group.priced ? (group.costSum / lineCount) * 100 : null,
        costPercent: totalCost > 0 ? (group.costSum / totalCost) * 100 : 0,
      };
    })
    .sort((a, b) => b.costSum - a.costSum);

const createProjectGroup = (key: string): ProjectGroup => ({
  key,
  sessions: 0,
  fresh: 0,
  cache: 0,
  cost: 0,
  priced: 0,
  turns: 0,
  tools: 0,
  linesAdded: 0,
  linesDeleted: 0,
});

const addProjectRow = (groups: Map<string, ProjectGroup>, row: DashboardRow) => {
  let group = groups.get(row.projectKey);
  if (!group) {
    group = createProjectGroup(row.projectKey);
    groups.set(row.projectKey, group);
  }

  group.sessions++;
  group.fresh += row.freshTokens;
  group.cache += row.tokCr;
  group.turns += row.turns;
  group.tools += row.tools;
  group.linesAdded += row.linesAdded ?? 0;
  group.linesDeleted += row.linesDeleted ?? 0;
  if (row.costKnown) {
    group.cost += row.costApprox;
    group.priced++;
  }
};

const buildAnalyticsGroups = (
  rows: DashboardRow[],
  acceptsRow: (row: DashboardRow) => boolean,
  keyForRow: (row: DashboardRow) => string,
  totalCost: number,
) => {
  const groups = new Map<string, MutableAnalyticsGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addAnalyticsRow(groups, keyForRow(row), row);
  }

  return finalizeAnalyticsGroups(groups, totalCost);
};

const buildProjectGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const projects = new Map<string, ProjectGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addProjectRow(projects, row);
  }

  return [...projects.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};

const SortHeader = (props: { column: Column<DashboardRow, unknown>; label: string }) => {
  const meta = () => props.column.columnDef.meta;
  const sortDirection = () => props.column.getIsSorted();

  return (
    <Show when={props.column.getCanSort()} fallback={<span class={meta()?.headerClass}>{props.label}</span>}>
      <button
        class={cx(sortButton, meta()?.headerClass)}
        type="button"
        title={meta()?.title}
        onClick={(event) => props.column.getToggleSortingHandler()?.(event)}
      >
        <span>{props.label}</span>
        <Show when={sortDirection()}>
          {(direction) => (
            <span class={sortArrow} aria-hidden="true">
              {direction() === 'asc' ? '↑' : '↓'}
            </span>
          )}
        </Show>
      </button>
    </Show>
  );
};

// Folded into a popover: column tuning is an occasional task, so it should
// not permanently cost two rows of prime space above the table.
const ColumnVisibilityControl = (props: {
  columnVisibility: VisibilityState;
  hiddenColumnIds?: string[];
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
}) => {
  const hideableColumns = () =>
    sessionColumns.filter((column) => column.enableHiding !== false && !props.hiddenColumnIds?.includes(column.id));
  const visibleCount = () =>
    visibleSessionColumns(props.columnVisibility).filter((column) => !props.hiddenColumnIds?.includes(column.id))
      .length;
  const setColumnVisible = (id: string, visible: boolean) =>
    props.onColumnVisibilityChange((current) => ({ ...current, [id]: visible }));

  return (
    <Popover.Root lazyMount unmountOnExit>
      <Popover.Trigger class={ghostButton}>Columns · {visibleCount()} ▾</Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content class={popoverContent} aria-label="Choose table columns">
          <div class={popoverHeader}>
            <span>
              {visibleCount()} of {sessionColumns.length} columns shown
            </span>
            <button
              class={ghostButton}
              type="button"
              onClick={() => props.onColumnVisibilityChange(defaultColumnVisibility)}
            >
              Reset
            </button>
          </div>
          <div class={popoverGrid}>
            <For each={hideableColumns()}>
              {(column) => (
                <label class={columnToggle}>
                  <input
                    class={columnToggleInput}
                    type="checkbox"
                    checked={isSessionColumnVisible(props.columnVisibility, column.id)}
                    onChange={(event) => setColumnVisible(column.id, event.currentTarget.checked)}
                  />
                  <span class={columnToggleText}>{sessionColumnLabel(column)}</span>
                </label>
              )}
            </For>
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
};

const DetailItem = (props: { label: string; value: string; hint?: string }) => (
  <div class={detailItem} title={props.hint}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const fmtRatio = (ratio: number) => (ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`);

const SessionDrawer = (props: {
  row: DashboardRow;
  rows: DashboardRow[];
  onClose: () => void;
  onNavigate: (delta: number) => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
}) => {
  let closeButton: HTMLButtonElement | undefined;
  // Move focus in on open and hand it back on close, so keyboard users are
  // not stranded; the inspector itself stays non-modal.
  onMount(() => {
    const previous = document.activeElement;
    closeButton?.focus();
    onCleanup(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  });

  const position = createMemo(() => props.rows.findIndex((row) => rowKey(row) === rowKey(props.row)));
  const medianCost = createMemo(() =>
    median(props.rows.filter((row) => row.costKnown && row.costApprox > 0).map((row) => row.costApprox)),
  );
  const medianDuration = createMemo(() =>
    median(props.rows.map((row) => row.durationMs ?? 0).filter((duration) => duration > 0)),
  );
  const costRatio = () =>
    props.row.costKnown && props.row.costApprox > 0 && medianCost() > 0 ? props.row.costApprox / medianCost() : null;
  const durationRatio = () =>
    (props.row.durationMs ?? 0) > 0 && medianDuration() > 0 ? (props.row.durationMs ?? 0) / medianDuration() : null;

  const anatomySegments = () => [
    { label: 'Cache read', value: props.row.tokCr, class: tokenSegmentClasses.cacheRead },
    { label: 'Cache write', value: props.row.tokCw, class: tokenSegmentClasses.cacheWrite },
    { label: 'Input', value: props.row.tokIn, class: tokenSegmentClasses.input },
    { label: 'Output', value: props.row.tokOut, class: tokenSegmentClasses.output },
  ];

  return (
    <aside class={drawer} role="dialog" aria-label="Session details">
      <div class={drawerTop}>
        <HarnessBadge name={props.row.harness} />
        <div class={drawerNav}>
          <span class={drawerPosition}>
            {fmtNum(position() + 1)} / {fmtNum(props.rows.length)}
          </span>
          <button
            class={drawerClose}
            type="button"
            aria-label="Previous session (k)"
            title="Previous session (k)"
            disabled={position() <= 0}
            onClick={() => props.onNavigate(-1)}
          >
            ↑
          </button>
          <button
            class={drawerClose}
            type="button"
            aria-label="Next session (j)"
            title="Next session (j)"
            disabled={position() >= props.rows.length - 1}
            onClick={() => props.onNavigate(1)}
          >
            ↓
          </button>
          <button
            ref={closeButton}
            class={drawerClose}
            type="button"
            aria-label="Close session details"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>
      </div>
      <div class={drawerBody}>
        <div>
          <div class={drawerTitle}>{props.row.sessionLabel}</div>
          <div class={muted}>
            {props.row.providerDisplay} · {props.row.model}
          </div>
        </div>
        <div>
          <SegmentBar segments={anatomySegments()} ariaLabel="Token anatomy" />
          <div class={drawerLegend} style={{ 'margin-top': '8px' }}>
            <For each={anatomySegments()}>
              {(segment) => (
                <div class={drawerLegendItem} title={`${segment.label}: ${fmtNum(segment.value)} tokens`}>
                  <span class={cx(drawerLegendSwatch, segment.class)} />
                  <span>{segment.label}</span>
                  <span class={drawerLegendValue}>{fmtCompact(segment.value)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={costRatio() != null || durationRatio() != null}>
          <div class={drawerCompare} title="Compared with the median session in the current view">
            <Show when={costRatio() != null}>≈ {fmtRatio(costRatio() ?? 0)} median cost</Show>
            <Show when={costRatio() != null && durationRatio() != null}> · </Show>
            <Show when={durationRatio() != null}>{fmtRatio(durationRatio() ?? 0)} median duration</Show>
          </div>
        </Show>
        <div class={drawerGrid}>
          <DetailItem label="Started" value={fmtDate(props.row.date)} />
          <DetailItem label="Ended" value={fmtDate(props.row.endDate)} />
          <DetailItem label="Total tokens" value={fmtNum(props.row.tokenTotal)} />
          <DetailItem label="RTK savings" value={rtkSavedLabel(props.row)} hint={rtkSavedTitle(props.row)} />
          <DetailItem
            label="API value"
            value={props.row.costKnown ? fmtMoney(props.row.costApprox) : '—'}
            hint={props.row.costKnown ? 'Estimated cost at standard API prices' : UNKNOWN_PRICE_HINT}
          />
          <DetailItem
            label="Actual cost"
            value={fmtMoney(props.row.costActual)}
            hint="Out-of-pocket spend — $0.00 means covered by a subscription"
          />
          <DetailItem label="Calls" value={fmtNum(props.row.calls)} />
          <DetailItem label="Turns" value={fmtNum(props.row.turns)} />
          <DetailItem label="Tools" value={fmtNum(props.row.tools)} />
          <DetailItem label="Duration" value={fmtDuration(props.row.durationMs)} />
          <DetailItem label="Lines" value={lineDeltaLabel(props.row)} />
          <DetailItem label="Subagent" value={props.row.subagent ? 'Yes' : 'No'} />
          <Show when={props.row.partial}>
            <DetailItem label="Partial" value="Yes" hint="Local history did not cover the whole session" />
          </Show>
          <Show when={props.row.usageUnavailable}>
            <DetailItem
              label="Usage data"
              value="Unavailable"
              hint="Session came from prompt history, but detailed local token counters are missing"
            />
          </Show>
        </div>
        <div class={drawerActions}>
          <button
            class={ghostButton}
            type="button"
            onClick={() => props.onFieldFilter('project', props.row.projectKey)}
          >
            Filter project: {props.row.projectKey}
          </button>
          <button class={ghostButton} type="button" onClick={() => props.onFieldFilter('model', props.row.modelKey)}>
            Filter model: {props.row.modelKey}
          </button>
        </div>
      </div>
    </aside>
  );
};

const SessionTable = (props: {
  rows: DashboardRow[];
  selectedKey: string | null;
  searchQuery: string;
  sorting: SortingState;
  columnVisibility: VisibilityState;
  onSortingChange: OnChangeFn<SortingState>;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
  onSelect: (row: DashboardRow) => void;
  onHarnessFilter: (value: string) => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onClearFilters: () => void;
}) => {
  // A column whose every visible row reads "—" is dead weight; RTK savings
  // only earns its slot when the filtered set actually carries RTK data.
  // Folding this into the visibility state keeps headers and cells in sync.
  const hasRtkData = createMemo(() => props.rows.some((row) => row.rtkSavedTokens));
  const effectiveVisibility = createMemo(() =>
    hasRtkData() ? props.columnVisibility : { ...props.columnVisibility, rtkSaved: false },
  );
  const dataHiddenColumnIds = () => (hasRtkData() ? [] : ['rtkSaved']);
  const sessionTable = createSolidTable<DashboardRow>({
    get data() {
      return props.rows;
    },
    columns: sessionColumns,
    get state() {
      return {
        sorting: props.sorting,
        columnVisibility: effectiveVisibility(),
      };
    },
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => rowKey(row),
    getSortedRowModel: getSortedRowModel(),
    meta: {
      onFieldFilter: props.onFieldFilter,
      onHarnessFilter: props.onHarnessFilter,
      get searchQuery() {
        return props.searchQuery;
      },
    },
    onColumnVisibilityChange: props.onColumnVisibilityChange,
    onSortingChange: props.onSortingChange,
  });
  const visibleColumns = createMemo(() =>
    visibleSessionColumns(effectiveVisibility())
      .map((columnDef) => ({ columnDef, tableColumn: sessionTable.getColumn(columnDef.id) }))
      .filter((column): column is { columnDef: SessionColumnDef; tableColumn: Column<DashboardRow, unknown> } =>
        Boolean(column.tableColumn),
      ),
  );
  const tableMinWidth = () =>
    Math.max(
      1040,
      visibleColumns().reduce((sum, { columnDef }) => sum + (columnDef.meta?.widthPx ?? 140), 0),
    );
  let tableViewportEl: HTMLDivElement | undefined;
  const rowHeight = 43;
  const overscanRows = 8;
  const [tableViewport, setTableViewport] = createSignal({ height: 520, scrollTop: 0 });
  const updateTableViewport = () => {
    const next = {
      height: tableViewportEl?.clientHeight ?? 520,
      scrollTop: tableViewportEl?.scrollTop ?? 0,
    };
    setTableViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  };
  const rowModelRows = createMemo(() => {
    props.rows;
    props.sorting;
    return sessionTable.getRowModel().rows;
  });
  const visibleColumnCount = () => visibleColumns().length;
  const virtualRows = createMemo(() => {
    const rows = rowModelRows();
    const viewport = tableViewport();
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscanRows);
    const end = Math.min(rows.length, start + Math.ceil(viewport.height / rowHeight) + overscanRows * 2);
    return {
      bottomHeight: Math.max(0, rows.length - end) * rowHeight,
      rows: rows.slice(start, end),
      topHeight: start * rowHeight,
    };
  });

  onMount(() => {
    updateTableViewport();
    const observer = new ResizeObserver(updateTableViewport);
    if (tableViewportEl) observer.observe(tableViewportEl);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    props.rows;
    props.sorting;
    if (tableViewportEl) tableViewportEl.scrollTop = 0;
    updateTableViewport();
  });

  return (
    <Show
      when={props.rows.length}
      fallback={
        <div class={empty}>
          <div class={emptyActions}>
            <span>No sessions match the current filters</span>
            <button class={ghostButton} type="button" onClick={() => props.onClearFilters()}>
              Clear filters
            </button>
          </div>
        </div>
      }
    >
      <div class={tableControls}>
        <ColumnVisibilityControl
          columnVisibility={props.columnVisibility}
          hiddenColumnIds={dataHiddenColumnIds()}
          onColumnVisibilityChange={props.onColumnVisibilityChange}
        />
      </div>
      <div class={tableWrap} ref={tableViewportEl} onScroll={updateTableViewport}>
        <table class={cx(table, sessionsTable)} style={{ 'min-width': `${tableMinWidth()}px` }}>
          <thead>
            <tr>
              <For each={visibleColumns()}>
                {({ columnDef, tableColumn }) => (
                  <th
                    class={columnDef.meta?.headerClass}
                    title={columnDef.meta?.title}
                    style={{ width: `${columnDef.meta?.widthPx ?? 140}px` }}
                  >
                    <SortHeader column={tableColumn} label={sessionColumnHeader(columnDef)} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show when={virtualRows().topHeight > 0}>
              <tr>
                <td
                  colSpan={visibleColumnCount()}
                  style={{ height: `${virtualRows().topHeight}px`, padding: '0', border: '0' }}
                />
              </tr>
            </Show>
            <For each={virtualRows().rows}>
              {(tableRow) => (
                <tr
                  data-selected={String(props.selectedKey === tableRow.id)}
                  tabIndex={0}
                  onClick={() => props.onSelect(tableRow.original)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    props.onSelect(tableRow.original);
                  }}
                >
                  <For each={tableRow.getVisibleCells()}>
                    {(cell) => (
                      <td class={cell.column.columnDef.meta?.cellClass}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <Show when={virtualRows().bottomHeight > 0}>
              <tr>
                <td
                  colSpan={visibleColumnCount()}
                  style={{ height: `${virtualRows().bottomHeight}px`, padding: '0', border: '0' }}
                />
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
    </Show>
  );
};

const analyticsGroupUnavailableOnly = (group: AnalyticsGroup) => group.usageUnavailable === group.sessions;
const groupFreshLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a fresh' : `${fmtCompact(group.fresh)} fresh`;
const groupFreshTitle = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`;
const groupCacheLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a cache' : `${fmtPct(group.cacheHitPct)} cache`;

const GroupPanel = (props: {
  title: string;
  groups: AnalyticsGroup[];
  countLabel: string;
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
}) => {
  const maxCost = createMemo(() => Math.max(1, ...props.groups.map((group) => group.costSum)));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <div class={groupCount} title={`${props.groups.length} ${props.countLabel}`}>
          {props.groups.length} {props.countLabel}
        </div>
      </div>
      <div class={groupRows}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <div>
                <Show when={props.onFilter} fallback={<div class={strongCell}>{group.key}</div>}>
                  <button class={groupKeyButton} type="button" onClick={() => props.onFilter?.(group.key)}>
                    {group.key}
                  </button>
                </Show>
                <div class={groupSub} title={groupFreshTitle(group)}>
                  {group.sessions} sess · {groupFreshLabel(group)} · {groupCacheLabel(group)}
                </div>
                <div class={barTrack}>
                  <div
                    class={cx(barFill, (props.harnessTones ? harnessFillFor(group.harness) : undefined) ?? accentFill)}
                    style={{
                      width: analyticsGroupUnavailableOnly(group)
                        ? '0%'
                        : `${Math.max(3, (group.costSum / maxCost()) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <div class={right}>
                <div class={groupValue}>
                  <Show when={!analyticsGroupUnavailableOnly(group)} fallback={<UsageUnavailableCell />}>
                    <Show when={group.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                      {fmtMoney(group.costSum)}
                    </Show>
                  </Show>
                </div>
                <div class={groupPct}>{fmtPct(group.costPercent)}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

type TimelinePart = { harness: string; cost: number };
type TimelineBucket = { date: Date; endDate: Date; total: number; sessions: number; parts: TimelinePart[] };

const timelineBucketTitle = (bucket: TimelineBucket, weekly: boolean, valueMode: 'cost' | 'sessions') =>
  [
    `${weekly ? 'Week of ' : ''}${fmtDateOnly(bucket.date)} — ${
      valueMode === 'cost' ? fmtMoney(bucket.total) : `${fmtNum(bucket.sessions)} sessions`
    }`,
    ...bucket.parts.map((part) => `${part.harness} ${fmtMoney(part.cost)}`),
  ].join('\n');

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });

// Month boundaries anchor the brush; the two endpoint labels only give the
// extremes, which is not enough to aim a selection on a long domain.
const monthTicksFor = (chart: { minDay: Date; maxDay: Date; maxIndex: number }) => {
  if (chart.maxIndex < 28) return [];
  const monthStep = chart.maxIndex > 430 ? 3 : 1;
  const ticks: { pct: number; label: string }[] = [];
  const cursor = new Date(chart.minDay.getFullYear(), chart.minDay.getMonth() + 1, 1);
  while (cursor <= chart.maxDay) {
    if (cursor.getMonth() % monthStep === 0) {
      const pct = (dateIndexFrom(cursor, chart.minDay) / chart.maxIndex) * 100;
      if (pct >= 2 && pct <= 98) {
        const label =
          cursor.getMonth() === 0
            ? `${monthTickFormatter.format(cursor)} ’${String(cursor.getFullYear()).slice(-2)}`
            : monthTickFormatter.format(cursor);
        ticks.push({ pct, label });
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
};

const TimeRangeControl = (props: {
  rows: DashboardRow[];
  dateRange: DateRangeController;
  activeHarness: string;
  onHarnessFilter: (value: string) => void;
  onDateRangeCommit: () => void;
}) => {
  const [chartDomain, setChartDomain] = createSignal(props.dateRange.domain());
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());
  createEffect(() => {
    props.rows;
    setChartDomain(untrack(() => props.dateRange.domain()));
  });

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) return null;
    const dated = props.rows
      .map((row) => ({ row, time: rowTime(row) }))
      .filter((item): item is { row: DashboardRow; time: number } => item.time != null);
    const dayCount = domain.maxIndex + 1;
    // Weekly buckets past ~4 months keep the bars readable (and the DOM small).
    const weekly = dayCount > 120;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const buckets = new Map<string, TimelineBucket & { byHarness: Map<string, number> }>();
    for (
      let cursor = bucketStart(domain.minDay);
      cursor <= domain.maxDay;
      cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)
    ) {
      buckets.set(toDateInputValue(cursor), {
        date: cursor,
        endDate: weekly ? shiftCalendarDays(cursor, 6) : cursor,
        total: 0,
        sessions: 0,
        parts: [],
        byHarness: new Map(),
      });
    }
    const harnessTotals = new Map<string, number>();
    for (const { row, time } of dated) {
      const bucket = buckets.get(toDateInputValue(bucketStart(new Date(time))));
      if (!bucket) continue;
      bucket.sessions++;
      if (row.costKnown) {
        bucket.total += row.costApprox;
        bucket.byHarness.set(row.harness, (bucket.byHarness.get(row.harness) ?? 0) + row.costApprox);
        harnessTotals.set(row.harness, (harnessTotals.get(row.harness) ?? 0) + row.costApprox);
      }
    }
    const harnesses = [...harnessTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const list = [...buckets.values()].map((bucket) => ({
      date: bucket.date,
      endDate: bucket.endDate > domain.maxDay ? domain.maxDay : bucket.endDate,
      total: bucket.total,
      sessions: bucket.sessions,
      parts: harnesses
        .map((name) => ({ harness: name, cost: bucket.byHarness.get(name) ?? 0 }))
        .filter((part) => part.cost > 0),
    }));
    const maxTotal = Math.max(...list.map((bucket) => bucket.total));
    const maxSessions = Math.max(...list.map((bucket) => bucket.sessions));
    const valueMode: 'cost' | 'sessions' = maxTotal > 0 ? 'cost' : 'sessions';
    const maxValue = valueMode === 'cost' ? maxTotal : maxSessions;
    if (maxValue <= 0) return null;
    return {
      list,
      maxValue,
      valueMode,
      weekly,
      harnesses,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  const [draggingSelection, setDraggingSelection] = createSignal(false);
  let selectionDrag: {
    pointerId: number;
    startX: number;
    startFrom: number;
    startTo: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;

  const indexesForValue = (value: number[]): [number, number] | null => {
    const chart = data();
    if (!chart) return null;
    return normalizeDateIndexRange(value, chart.maxIndex);
  };

  const previewSliderValue = (value: number[]) => {
    const nextIndexes = indexesForValue(value);
    if (!nextIndexes) return;
    props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
  };

  const commitIndexes = (value?: number[]) => {
    if (value) {
      const nextIndexes = indexesForValue(value);
      if (nextIndexes) props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
    }
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyPreset = (mode: TimeRangePreset) => {
    props.dateRange.setPreset(mode);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyFromInput = (from: string) => {
    props.dateRange.setFromInput(from);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyToInput = (to: string) => {
    props.dateRange.setToInput(to);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const startSelectionDrag = (event: RangeDragPointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (event.button !== 0) return;
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) return;
    const [startFrom, startTo] = props.dateRange.selectedIndexes();
    selectionDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startFrom,
      startTo,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    setDraggingSelection(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    const span = selectionDrag.startTo - selectionDrag.startFrom;
    const delta = Math.round(
      ((event.clientX - selectionDrag.startX) / selectionDrag.trackWidth) * selectionDrag.maxIndex,
    );
    const from = clampNumber(selectionDrag.startFrom + delta, 0, Math.max(0, selectionDrag.maxIndex - span));
    props.dateRange.setIndexes(from, from + span);
    event.preventDefault();
    event.stopPropagation();
  };

  const endSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    selectionDrag = null;
    commitIndexes();
    setDraggingSelection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Show
      when={data()}
      fallback={
        <section class={timeRangePanel} aria-label="Date range">
          <div>
            <div class={timeRangeTitle}>Time range</div>
            <div class={timeRangeMeta}>No dated sessions match the current filters</div>
          </div>
        </section>
      }
    >
      {(chart) => (
        <section class={timeRangePanel} aria-label="Date range">
          <div class={timeRangeHeader}>
            <div>
              <div class={timeRangeTitle}>Time range</div>
              <div class={timeRangeMeta}>{props.dateRange.label()}</div>
            </div>
            <fieldset class={presetGroup} aria-label="Date presets">
              <For each={dateRangePresets}>
                {(preset) => (
                  <button
                    class={presetButton}
                    type="button"
                    data-active={String(props.dateRange.mode() === preset.mode)}
                    onClick={() => applyPreset(preset.mode)}
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </fieldset>
          </div>

          <div class={dateEditRow}>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>From</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().from}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyFromInput(event.currentTarget.value)}
              />
            </label>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>To</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().to}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyToInput(event.currentTarget.value)}
              />
            </label>
            <div class={chartLegend}>
              <For each={chart().harnesses}>
                {(name) => (
                  <HarnessBadge
                    name={name}
                    active={props.activeHarness === name}
                    title={props.activeHarness === name ? `Clear ${name} filter` : `Filter by ${name}`}
                    onClick={() => props.onHarnessFilter(name)}
                  />
                )}
              </For>
            </div>
          </div>

          <Slider.Root
            class={timeSliderRoot}
            min={0}
            max={chart().maxIndex}
            step={1}
            value={props.dateRange.selectedIndexes()}
            thumbSize={{ width: 32, height: 64 }}
            aria-label={['Start date', 'End date']}
            getAriaValueText={(details) => fmtDateOnly(dateFromIndex(chart().minDay, details.value))}
            onValueChange={(details) => previewSliderValue(details.value)}
            onValueChangeEnd={(details) => commitIndexes(details.value)}
          >
            <Slider.Control class={timeSliderControl}>
              <Slider.Track class={timeSliderTrack}>
                <For each={monthTicksFor(chart())}>
                  {(tick) => <div class={monthGridline} style={{ left: `${tick.pct}%` }} aria-hidden="true" />}
                </For>
                <Slider.Range class={timeSliderRange} />
                <div class={timeSliderBars} aria-hidden="true">
                  <For each={chart().list}>
                    {(bucket) => (
                      <div class={timeBucket} title={timelineBucketTitle(bucket, chart().weekly, chart().valueMode)}>
                        <Show
                          when={chart().valueMode === 'cost'}
                          fallback={
                            <div
                              class={cx(timeBucketSegment, accentFill)}
                              style={{ height: `${Math.max(2, (bucket.sessions / chart().maxValue) * 100)}%` }}
                            />
                          }
                        >
                          <For each={bucket.parts}>
                            {(part) => (
                              <div
                                class={cx(timeBucketSegment, harnessFillFor(part.harness) ?? accentFill)}
                                style={{ height: `${Math.max(2, (part.cost / chart().maxValue) * 100)}%` }}
                              />
                            )}
                          </For>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <div class={timeSliderDimLeft} aria-hidden="true" />
                <div class={timeSliderDimRight} aria-hidden="true" />
                <button
                  class={timeSliderRangeDrag}
                  type="button"
                  tabIndex={-1}
                  aria-label="Drag selected date range"
                  title="Drag selected range"
                  data-dragging={String(draggingSelection())}
                  onPointerDown={(event) => startSelectionDrag(event, chart())}
                  onPointerMove={moveSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  onLostPointerCapture={endSelectionDrag}
                />
              </Slider.Track>
              <Slider.Thumb index={0} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
              <Slider.Thumb index={1} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
            <div class={timeAxis}>
              <span>{fmtDateOnly(chart().minDay)}</span>
              <For each={monthTicksFor(chart()).filter((tick) => tick.pct >= 7 && tick.pct <= 93)}>
                {(tick) => (
                  <span class={timeAxisTick} style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                )}
              </For>
              <span>{fmtDateOnly(chart().maxDay)}</span>
            </div>
          </Slider.Root>
        </section>
      )}
    </Show>
  );
};

const ProjectSummary = (props: { groups: ProjectGroup[]; onProjectFilter: (value: string) => void }) => (
  <Show when={props.groups.length} fallback={<div class={empty}>No projects</div>}>
    <div class={tableWrap}>
      <table class={cx(table, projectTable)}>
        <thead>
          <tr>
            <th>Project</th>
            <th style={{ width: '88px' }} class={right}>
              Sessions
            </th>
            <th style={{ width: '110px' }} class={right}>
              Fresh
            </th>
            <th style={{ width: '110px' }} class={right}>
              Cache
            </th>
            <th style={{ width: '96px' }} class={right}>
              $API
            </th>
            <th style={{ width: '110px' }} class={right}>
              Lines
            </th>
            <th style={{ width: '96px' }} class={right}>
              Turns
            </th>
            <th style={{ width: '96px' }} class={right}>
              Tools
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.groups}>
            {(project) => (
              <tr>
                <td
                  class={strongCell}
                  title={project.key === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                >
                  <button class={groupKeyButton} type="button" onClick={() => props.onProjectFilter(project.key)}>
                    {project.key}
                  </button>
                </td>
                <td class={numCell}>{fmtNum(project.sessions)}</td>
                <td class={numCell} title={fmtNum(project.fresh)}>
                  {fmtCompact(project.fresh)}
                </td>
                <td class={numCell} title={fmtNum(project.cache)}>
                  {fmtCompact(project.cache)}
                </td>
                <td class={numCell}>
                  <Show when={project.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                    {fmtMoney(project.cost)}
                  </Show>
                </td>
                <td class={numCell}>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
                </td>
                <td class={numCell}>{fmtNum(project.turns)}</td>
                <td class={numCell}>{fmtNum(project.tools)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

const cursorAiLineTotal = (row: CursorCommitAttributionFacet) =>
  row.composerLinesAdded + row.composerLinesDeleted + row.tabLinesAdded + row.tabLinesDeleted;

const uniqueCursorCommits = (rows: CursorCommitAttributionFacet[]) => new Set(rows.map((row) => row.commitHash)).size;

const CursorAttributionPanel = (props: { rows: CursorCommitAttributionFacet[] }) => {
  const totals = createMemo(() =>
    props.rows.reduce(
      (acc, row) => ({
        aiLines: acc.aiLines + cursorAiLineTotal(row),
        blankLines: acc.blankLines + row.blankLinesAdded + row.blankLinesDeleted,
        humanLines: acc.humanLines + row.humanLinesAdded + row.humanLinesDeleted,
        totalLines: acc.totalLines + row.linesAdded + row.linesDeleted,
      }),
      { aiLines: 0, blankLines: 0, humanLines: 0, totalLines: 0 },
    ),
  );
  const aiPct = () => (totals().totalLines ? (totals().aiLines / totals().totalLines) * 100 : 0);

  return (
    <Show
      when={props.rows.length}
      fallback={<div class={empty}>No Cursor commit attribution data in this payload</div>}
    >
      <div class={metricGrid}>
        <MetricTile
          label="Scored commits"
          value={fmtNum(uniqueCursorCommits(props.rows))}
          hint="Unique commit hashes scored by Cursor"
        />
        <MetricTile
          label="Branch rows"
          value={fmtNum(props.rows.length)}
          hint="Cursor stores attribution per branch, so commits can repeat"
        />
        <MetricTile
          label="AI line share"
          value={fmtPct(aiPct())}
          hint="Composer + Tab lines over scored added/deleted lines"
        />
        <MetricTile
          label="Human lines"
          value={fmtNum(totals().humanLines)}
          hint="Lines Cursor classified as human-authored"
        />
      </div>

      <div class={tableWrap}>
        <table class={table} style={{ 'min-width': '1120px' }}>
          <thead>
            <tr>
              <th>Commit</th>
              <th style={{ width: '150px' }}>Branch</th>
              <th style={{ width: '110px' }} class={right}>
                AI %
              </th>
              <th style={{ width: '120px' }} class={right}>
                Composer
              </th>
              <th style={{ width: '100px' }} class={right}>
                Tab
              </th>
              <th style={{ width: '110px' }} class={right}>
                Human
              </th>
              <th style={{ width: '130px' }} class={right}>
                Total +/-
              </th>
              <th style={{ width: '150px' }}>Scored</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <td class={strongCell} title={row.commitHash}>
                    <div>{row.commitMessage || row.commitHash.slice(0, 10)}</div>
                    <div class={meta}>{row.commitHash.slice(0, 10)}</div>
                  </td>
                  <td>{row.branchName}</td>
                  <td class={numCell}>{row.v2AiPercentage == null ? '—' : fmtPct(row.v2AiPercentage)}</td>
                  <td class={numCell}>
                    +{fmtNum(row.composerLinesAdded)}/-{fmtNum(row.composerLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.tabLinesAdded)}/-{fmtNum(row.tabLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.humanLinesAdded)}/-{fmtNum(row.humanLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.linesAdded)}/-{fmtNum(row.linesDeleted)}
                  </td>
                  <td>{fmtDate(row.scoredAt)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
};

const formatRefreshCountdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
};

const formatRefreshAge = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

type RefreshStatusKind = 'idle' | 'refreshing' | 'success' | 'delayed' | 'error' | 'paused' | 'static';

const refreshStatusLabels: Record<RefreshStatusKind, string> = {
  delayed: 'Delayed',
  error: 'Error',
  idle: 'Ready',
  paused: 'Paused',
  refreshing: 'Refreshing',
  static: 'Static',
  success: 'Live',
};

const refreshRingClass: Record<RefreshStatusKind, string> = {
  delayed: refreshRingDelayed,
  error: refreshRingError,
  idle: refreshRingIdle,
  paused: refreshRingPaused,
  refreshing: refreshRingRefreshing,
  static: refreshRingStatic,
  success: refreshRingSuccess,
};

const RefreshStatus = (props: {
  canRefresh: boolean;
  generatedAt: string;
  lastRefreshError: string | null;
  lastSuccessfulRefreshAt: number | null;
  nextRefreshAt: number | null;
  onTogglePause: () => void;
  refreshErrorCount: number;
  refreshIntervalMs: number;
  refreshPaused: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) => {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const countdown = createMemo(() => {
    const next = props.nextRefreshAt;
    if (!next) return 'paused';
    return formatRefreshCountdown(next - now());
  });
  const remainingRatio = createMemo(() => {
    if (!props.canRefresh || props.refreshPaused || props.nextRefreshAt == null) return 0;
    if (props.refreshing) return 1;
    return Math.max(0, Math.min(1, (props.nextRefreshAt - now()) / props.refreshIntervalMs));
  });
  const status = createMemo<RefreshStatusKind>(() => {
    if (!props.canRefresh) return 'static';
    if (props.refreshPaused) return 'paused';
    if (props.refreshing) return 'refreshing';
    if (props.refreshErrorCount >= 2) return 'error';
    if (props.refreshErrorCount === 1) return 'delayed';
    return props.lastSuccessfulRefreshAt == null ? 'idle' : 'success';
  });
  const statusLabel = () => refreshStatusLabels[status()];
  const primaryLabel = createMemo(() => {
    const currentStatus = status();
    if (currentStatus === 'static') return 'Static';
    if (currentStatus === 'paused') return 'Paused';
    if (currentStatus === 'refreshing') return 'Refreshing';
    if (currentStatus === 'delayed' || currentStatus === 'error') return `${statusLabel()} · retry ${countdown()}`;
    return `Next ${countdown()}`;
  });
  const tooltipLines = createMemo(() => {
    const lines = [`Status: ${statusLabel()}`, `Generated: ${fmtDate(props.generatedAt)}`];
    if (props.canRefresh) lines.push(`Interval: ${formatRefreshCountdown(props.refreshIntervalMs)}`);
    else lines.push('Auto-refresh unavailable for static snapshots');
    if (props.canRefresh && !props.refreshPaused) lines.push(`Next refresh: ${countdown()}`);
    if (props.refreshPaused) lines.push('Auto-refresh is paused');
    if (props.lastSuccessfulRefreshAt != null) {
      lines.push(`Last successful refresh: ${formatRefreshAge(now() - props.lastSuccessfulRefreshAt)}`);
    }
    if (props.lastRefreshError) lines.push(`Last error: ${props.lastRefreshError}`);
    return lines;
  });

  return (
    <Tooltip.Root openDelay={400} positioning={{ placement: 'bottom' }}>
      <Tooltip.Trigger
        class={cx(refreshStatus, status() === 'delayed' || status() === 'error' ? refreshStatusError : undefined)}
      >
        <span
          class={cx(refreshRing, refreshRingClass[status()])}
          role="status"
          aria-live="polite"
          aria-label={`Data refresh status: ${primaryLabel()}`}
          style={{ '--refresh-progress': String(remainingRatio()) }}
        />
        <button
          class={refreshButton}
          type="button"
          disabled={!props.canRefresh || props.refreshing}
          onClick={props.onRefresh}
        >
          Refresh
        </button>
        <button
          class={refreshIconButton}
          type="button"
          disabled={!props.canRefresh}
          aria-label={props.refreshPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          onClick={props.onTogglePause}
        >
          {props.refreshPaused ? '>' : '||'}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Positioner>
        <Tooltip.Content class={tooltipContent}>
          <For each={tooltipLines()}>{(line) => <div>{line}</div>}</For>
        </Tooltip.Content>
      </Tooltip.Positioner>
    </Tooltip.Root>
  );
};

export const Dashboard = () => {
  const [payload, setPayload] = createSignal<UsageReportPayload>(initialPayload);
  const isDemo = isDemoReportPayload();
  const canRefresh = !isDemo && typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol);
  const [refreshing, setRefreshing] = createSignal(false);
  const [lastRefreshError, setLastRefreshError] = createSignal<string | null>(null);
  const [lastSuccessfulRefreshAt, setLastSuccessfulRefreshAt] = createSignal<number | null>(null);
  const [refreshErrorCount, setRefreshErrorCount] = createSignal(0);
  const [refreshPaused, setRefreshPaused] = createSignal(false);
  const [nextRefreshAt, setNextRefreshAt] = createSignal<number | null>(
    canRefresh ? Date.now() + REFRESH_INTERVAL_MS : null,
  );
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const updateSearch = (updater: (current: DashboardSearch) => DashboardSearch, options?: { replace?: boolean }) =>
    void navigate({
      search: updater(search()),
      ...(options?.replace == null ? {} : { replace: options.replace }),
    });
  const query = () => search().q;
  const harness = () => search().harness;
  const fieldFilters = () => search().filters;
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const columnVisibility = createMemo(() => columnVisibilityFromDiff(search().cols));
  const generatedAt = createMemo(() => new Date(payload().generatedAt));
  const reportRows = createMemo(() => payload().rows.map(enrichReportRow));
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let searchInputEl: HTMLInputElement | undefined;
  const cursorCommitRows = createMemo(() => cursorCommitAttributionFacet(payload()));
  const harnesses = createMemo(() => ['all', ...new Set(reportRows().map((row) => row.harness))]);
  const filterSnapshot = createMemo(() => createFilterSnapshot(query(), harness(), fieldFilters()));
  const timelineRows = createMemo(() => {
    const filters = filterSnapshot();
    return reportRows().filter((row) => matchesFilterSnapshot(row, filters));
  });
  const initialRange = search().range;
  const dateRange = createDateRangeController({
    generatedAt,
    rows: timelineRows,
    defaultFrom: toDateInputValue(startOfDay(shiftCalendarDays(generatedAt(), -6))),
    defaultTo: toDateInputValue(generatedAt()),
    formatDate: fmtDateOnly,
    initialMode: initialRange.mode,
    ...(initialRange.from ? { initialFrom: initialRange.from } : {}),
    ...(initialRange.to ? { initialTo: initialRange.to } : {}),
  });
  const [tableDateBounds, setTableDateBounds] = createSignal<DateBounds>(dateRange.bounds());
  const searchRangeFromDateRange = (): DashboardSearch['range'] => {
    const mode = dateRange.mode();
    if (mode !== 'custom') return { mode };
    const values = dateRange.inputValues();
    return {
      mode,
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
    };
  };
  const commitTableDateRange = () => {
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, range: searchRangeFromDateRange() }));
  };
  createEffect(() => {
    const range = search().range;
    untrack(() => {
      const values = dateRange.inputValues();
      const matchesRange =
        dateRange.mode() === range.mode &&
        (range.mode !== 'custom' || (values.from === (range.from ?? '') && values.to === (range.to ?? '')));
      if (!matchesRange) dateRange.setRange(range.mode, range.from, range.to);
      setTableDateBounds(dateRange.bounds());
    });
  });
  const tableFilteredRows = createMemo(() => {
    const bounds = tableDateBounds();
    return timelineRows().filter((row) => rowMatchesDateBounds(row, bounds));
  });
  const tableRows = tableFilteredRows;
  // Rows in the table's current sort order — shared by CSV export and the
  // drawer's previous/next navigation so both walk the list the user sees.
  const sortedRows = createMemo(() => [...tableFilteredRows()].sort(compareRows(sorting())));
  // The drawer closes by itself when its row leaves the filtered set.
  const selectedRow = createMemo(() => tableFilteredRows().find((row) => rowKey(row) === selectedKey()) ?? null);
  const navigateSelected = (delta: number) => {
    const rows = sortedRows();
    const key = selectedKey();
    const index = rows.findIndex((row) => rowKey(row) === key);
    if (index === -1) return;
    const next = rows[index + delta];
    if (next) setSelectedKey(rowKey(next));
  };
  createEffect(() => {
    if (!selectedRow()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.key === 'Escape') {
        setSelectedKey(null);
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        navigateSelected(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        navigateSelected(-1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  // "/" jumps to the filter input, mirroring the CLI feel of the report.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
      event.preventDefault();
      searchInputEl?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  const visibleSummary = createMemo(() => {
    const bounds = dateRange.bounds();
    return buildReportSummary(timelineRows(), (row) => rowMatchesDateBounds(row, bounds));
  });
  const modelGroups = createMemo(() => {
    if (search().tab !== 'models') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.modelKey,
      visibleSummary().totalCost,
    );
  });
  const providerGroups = createMemo(() => {
    if (search().tab !== 'providers') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.providerDisplay,
      visibleSummary().totalCost,
    );
  });
  const harnessGroups = createMemo(() => {
    if (search().tab !== 'harnesses') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.harness,
      visibleSummary().totalCost,
    );
  });
  const projectGroupRows = createMemo(() => {
    if (search().tab !== 'projects') return [];
    const bounds = dateRange.bounds();
    return buildProjectGroups(timelineRows(), (row) => rowMatchesDateBounds(row, bounds));
  });
  const hiddenCount = createMemo(() => reportRows().length - visibleSummary().sessionCount);
  // Usage in the equally-long window right before the selected one; null when
  // the range is open-ended ("All") or the previous window is empty.
  const previousSummary = createMemo(() => {
    const bounds = dateRange.bounds();
    if (!bounds.from) return null;
    const from = bounds.from.getTime();
    const to = (bounds.to ?? endOfDay(generatedAt())).getTime();
    const span = Math.max(DAY_MS, to - from);
    const previousBounds: DateBounds = { from: new Date(from - span), to: new Date(from - 1) };
    const summary = buildReportSummary(timelineRows(), (row) => rowMatchesDateBounds(row, previousBounds));
    return summary.sessionCount > 0 ? summary : null;
  });
  const exportRows = () => sortedRows();
  const refreshPayload = async (force = false) => {
    if (!canRefresh || refreshing()) return;
    setRefreshing(true);
    try {
      setPayload(await fetchReportPayload({ force }));
      setLastRefreshError(null);
      setLastSuccessfulRefreshAt(Date.now());
      setRefreshErrorCount(0);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } catch (error) {
      setLastRefreshError(error instanceof Error ? error.message : 'Failed to refresh report payload');
      setRefreshErrorCount((count) => count + 1);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } finally {
      setRefreshing(false);
    }
  };
  const toggleRefreshPause = () => {
    setRefreshPaused((paused) => {
      if (paused) setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
      return !paused;
    });
  };
  createEffect(() => {
    if (!canRefresh || refreshPaused() || refreshing()) return;
    const next = nextRefreshAt();
    if (next == null) return;
    const timer = window.setTimeout(() => void refreshPayload(), Math.max(0, next - Date.now()));
    onCleanup(() => window.clearTimeout(timer));
  });
  const toggleSelected = (row: DashboardRow) =>
    setSelectedKey((current) => (current === rowKey(row) ? null : rowKey(row)));
  let activeQueryEdit = false;
  const commitQueryEdit = () => {
    activeQueryEdit = false;
  };
  const setQuery = (q: string) => {
    const replace = activeQueryEdit;
    activeQueryEdit = true;
    updateSearch((current) => ({ ...current, q }), { replace });
  };
  const setHarness = (nextHarness: string) => updateSearch((current) => ({ ...current, harness: nextHarness }));
  const toggleHarness = (name: string) => setHarness(harness() === name ? 'all' : name);
  const focusDay = (day: Date) => {
    const value = toDateInputValue(day);
    dateRange.setCustom(value, value);
    commitTableDateRange();
  };
  const setFieldFilters = (updater: Updater<FieldFilters>) =>
    updateSearch((current) => ({ ...current, filters: applyTableUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string) =>
    setFieldFilters((current) => ({ ...current, [key]: value }));
  const clearFieldFilter = (key: FieldFilterKey) =>
    setFieldFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const clearFilters = () => {
    dateRange.clear();
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, filters: {}, harness: 'all', q: '', range: { mode: 'all' } }));
  };
  const handleSortingChange: OnChangeFn<SortingState> = (updater) =>
    updateSearch((current) => ({
      ...current,
      sort: sortFromSortingState(applyTableUpdate(updater, sortingStateFromSearch(current.sort))),
    }));
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) =>
    updateSearch((current) => {
      const nextVisibility = applyTableUpdate(updater, columnVisibilityFromDiff(current.cols));
      return { ...current, cols: columnDiffFromVisibility(nextVisibility) };
    });
  const setTab = (tab: string) => {
    if (!isDashboardTab(tab)) return;
    updateSearch((current) => ({ ...current, tab }));
  };
  const deltaVs = (current: number, previous: number | undefined, fmt: (n: number) => string): MetricDelta | null => {
    if (previous == null || previous <= 0) return null;
    return {
      pct: ((current - previous) / previous) * 100,
      hint: `Previous period of equal length: ${fmt(previous)}`,
    };
  };
  const metrics = createMemo<Metric[]>(() => {
    const a = visibleSummary();
    const prev = previousSummary() ?? undefined;
    return [
      {
        label: 'Sessions',
        value: fmtNum(a.sessionCount),
        hint: 'Sessions in the current filter',
        delta: deltaVs(a.sessionCount, prev?.sessionCount, fmtNum),
      },
      {
        label: 'API value',
        value: fmtMoney(a.totalCost),
        hint: 'Estimated cost at standard API prices, including usage covered by subscriptions',
        delta: deltaVs(a.totalCost, prev?.totalCost, fmtMoney),
      },
      {
        label: 'Actual cost',
        value: fmtMoney(a.actualCost),
        hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
          a.unknownActual ? ` (${fmtNum(a.unknownActual)} sessions unknown)` : ''
        }`,
        delta: deltaVs(a.actualCost, prev?.actualCost, fmtMoney),
      },
      { label: 'Mean / sess', value: fmtMoney(a.meanCost), hint: 'Mean API value per priced session' },
      {
        label: 'Fresh tokens',
        value: fmtCompact(a.fresh),
        hint: `Tokens processed without cache: ${fmtNum(a.fresh)}`,
        delta: deltaVs(a.fresh, prev?.fresh, fmtCompact),
      },
      ...(a.rtkSaved
        ? [
            {
              label: 'RTK savings',
              value: fmtPct(a.rtkInput ? (a.rtkSaved / a.rtkInput) * 100 : 0),
              hint: [
                `${fmtNum(a.rtkSaved)} tokens saved in matched sessions`,
                `${fmtNum(a.rtkInput)} RTK input tokens before filtering`,
                `${fmtNum(a.rtkOutput)} RTK output tokens after filtering`,
              ].join('\n'),
            },
          ]
        : []),
      {
        label: 'Turns',
        value: fmtNum(a.turns),
        hint: 'Assistant turns across the filtered sessions',
        delta: deltaVs(a.turns, prev?.turns, fmtNum),
      },
      {
        label: 'Tool calls',
        value: fmtNum(a.tools),
        hint: 'Tool invocations across the filtered sessions',
        delta: deltaVs(a.tools, prev?.tools, fmtNum),
      },
    ];
  });

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
                <Show when={isDemoReportPayload()}>
                  <span class={demoBadge}>Demo data</span>
                </Show>
              </div>
              <h1 class={title}>Usage report</h1>
              <div class={meta}>
                <Show when={!isDemo} fallback="Report payload unavailable">
                  Generated {fmtDate(payload().generatedAt)}
                </Show>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <Show when={!isDemo}>
          <div class={toolbar}>
            <input
              ref={searchInputEl}
              class={searchInput}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onBlur={commitQueryEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitQueryEdit();
              }}
              placeholder="Filter by title, project, model…  ( / )"
              aria-label="Filter sessions by title, project, model, provider, or harness"
            />
            <select class={selectInput} value={harness()} onChange={(event) => setHarness(event.currentTarget.value)}>
              <For each={harnesses()}>
                {(item) => <option value={item}>{item === 'all' ? 'All harnesses' : item}</option>}
              </For>
            </select>
            <RefreshStatus
              canRefresh={canRefresh}
              generatedAt={payload().generatedAt}
              lastRefreshError={lastRefreshError()}
              lastSuccessfulRefreshAt={lastSuccessfulRefreshAt()}
              nextRefreshAt={nextRefreshAt()}
              onTogglePause={toggleRefreshPause}
              refreshErrorCount={refreshErrorCount()}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
              refreshPaused={refreshPaused()}
              refreshing={refreshing()}
              onRefresh={() => void refreshPayload(true)}
            />
            <button
              class={commandButton}
              type="button"
              onClick={() => downloadCSV(exportRows(), payload().generatedAt)}
            >
              Export CSV
            </button>
            <Show when={!import.meta.env.DEV}>
              <button class={ghostButton} type="button" onClick={() => void downloadHTML(payload())}>
                Export HTML
              </button>
            </Show>
          </div>
        </Show>

        <Show
          when={!isDemo}
          fallback={
            <section class={unavailablePanel}>
              <div class={unavailableTitle}>Real report data is not loaded</div>
              <div class={unavailableText}>
                The CLI payload was not injected into this page, so usage metrics are hidden instead of showing demo
                fixture data.
              </div>
            </section>
          }
        >
          <TimeRangeControl
            rows={timelineRows()}
            dateRange={dateRange}
            activeHarness={harness()}
            onHarnessFilter={toggleHarness}
            onDateRangeCommit={commitTableDateRange}
          />

          <div class={filterSummary}>
            <span class={summaryPill} aria-live="polite">
              {fmtNum(visibleSummary().sessionCount)} / {fmtNum(reportRows().length)} sessions
            </span>
            <Show when={hiddenCount() > 0}>
              <span>{fmtNum(hiddenCount())} hidden by filters</span>
            </Show>
            <div class={activeFilters}>
              <Show when={harness() !== 'all'}>
                <FilterPill label="Harness" value={harness()} onClear={() => setHarness('all')} />
              </Show>
              <For each={Object.entries(fieldFilters()) as [FieldFilterKey, string][]}>
                {([key, value]) => (
                  <FilterPill label={fieldFilterLabels[key]} value={value} onClear={() => clearFieldFilter(key)} />
                )}
              </For>
            </div>
          </div>

          <div class={metricGrid}>
            <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
          </div>

          <Tabs.Root
            value={search().tab}
            class={tabsRoot}
            lazyMount
            unmountOnExit
            onValueChange={(details) => setTab(details.value)}
          >
            <Tabs.List class={tabsList}>
              <Tabs.Trigger value="overview" class={tabTrigger}>
                Overview
              </Tabs.Trigger>
              <Tabs.Trigger value="sessions" class={tabTrigger}>
                Sessions
              </Tabs.Trigger>
              <Tabs.Trigger value="models" class={tabTrigger}>
                Models
              </Tabs.Trigger>
              <Tabs.Trigger value="providers" class={tabTrigger}>
                Providers
              </Tabs.Trigger>
              <Tabs.Trigger value="harnesses" class={tabTrigger}>
                Harnesses
              </Tabs.Trigger>
              <Tabs.Trigger value="projects" class={tabTrigger}>
                Projects
              </Tabs.Trigger>
              <Tabs.Trigger value="cursor-ai" class={tabTrigger}>
                Cursor AI
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="overview" class={section}>
              <Overview
                rows={tableRows()}
                timelineRows={timelineRows()}
                summary={visibleSummary()}
                rangeLabel={dateRange.label()}
                onSelectSession={(row) => setSelectedKey(rowKey(row))}
                onSelectDay={focusDay}
              />
            </Tabs.Content>
            <Tabs.Content value="sessions" class={section}>
              <SessionTable
                rows={tableRows()}
                selectedKey={selectedKey()}
                searchQuery={query()}
                sorting={sorting()}
                columnVisibility={columnVisibility()}
                onSortingChange={handleSortingChange}
                onColumnVisibilityChange={handleColumnVisibilityChange}
                onSelect={toggleSelected}
                onHarnessFilter={setHarness}
                onFieldFilter={setFieldFilter}
                onClearFilters={clearFilters}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class={section}>
              <GroupPanel
                title="By model"
                groups={modelGroups()}
                countLabel="models"
                harnessTones
                onFilter={(value) => setFieldFilter('model', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="providers" class={section}>
              <GroupPanel
                title="By provider"
                groups={providerGroups()}
                countLabel="providers"
                harnessTones
                onFilter={(value) => setFieldFilter('provider', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="harnesses" class={section}>
              <GroupPanel
                title="By harness"
                groups={harnessGroups()}
                countLabel="harnesses"
                harnessTones
                onFilter={setHarness}
              />
            </Tabs.Content>
            <Tabs.Content value="projects" class={section}>
              <ProjectSummary
                groups={projectGroupRows()}
                onProjectFilter={(value) => setFieldFilter('project', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="cursor-ai" class={section}>
              <CursorAttributionPanel rows={cursorCommitRows()} />
            </Tabs.Content>
          </Tabs.Root>

          <Show when={selectedRow()}>
            {(row) => (
              <SessionDrawer
                row={row()}
                rows={sortedRows()}
                onClose={() => setSelectedKey(null)}
                onNavigate={navigateSelected}
                onFieldFilter={setFieldFilter}
              />
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
};
