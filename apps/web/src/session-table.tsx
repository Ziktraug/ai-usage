import { Checkbox, Popover } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  desktopTableSurface,
  empty,
  emptyActions,
  ghostButton,
  mobileSummarySurface,
  popoverContent,
  popoverGrid,
  popoverHeader,
  presetButton,
  presetGroup,
  sessionDesktopControl,
  sessionPagingLoadMore,
  sessionSummaryCard,
  sessionSummaryDate,
  sessionSummaryFilter,
  sessionSummaryFilters,
  sessionSummaryFooter,
  sessionSummaryHeader,
  sessionSummaryLoadMore,
  sessionSummaryMobileSort,
  sessionSummaryMobileSortField,
  sessionSummaryMobileSortSelect,
  sessionSummaryOpen,
  sessionSummaryRow,
  sessionSummaryStats,
  sessionSummaryTitle,
  sessionSummaryValue,
  sessionSummaryViewport,
  sessionsTable,
  sortArrow,
  sortButton,
  table,
  tableControls,
  tableWrap,
} from '@ai-usage/design-system/report';
import type { Column, ExpandedState, OnChangeFn, Row, SortingState, VisibilityState } from '@tanstack/solid-table';
import { createSolidTable, flexRender, getCoreRowModel, getExpandedRowModel } from '@tanstack/solid-table';
import { type Accessor, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { measureClientPerf } from './client-perf';
import type { FieldFilterKey } from './dashboard-search';
import { HighlightedText } from './highlighted-text';
import { sessionDurationSemantics } from './session-analysis-model';
import {
  defaultColumnVisibility,
  isSessionColumnVisible,
  type SessionColumnDef,
  sessionColumnHeader,
  sessionColumnLabel,
  sessionColumns,
  visibleSessionColumns,
} from './session-columns';
import { calculateSessionRowWindow } from './session-row-window';
import {
  browserSessionSurfaceModeEnvironment,
  createSessionSurfaceModeController,
  type SessionSurfaceMode,
} from './session-surface-mode';
import {
  columnVisibilityForSessionPreset,
  sessionColumnPresetForVisibility,
  sessionColumnPresets,
} from './session-table-schema';
import {
  apiValuePresentation,
  type DashboardRow,
  fmtCompact,
  fmtDate,
  fmtDuration,
  HarnessBadge,
  rowKey,
  USAGE_UNAVAILABLE_HINT,
} from './shared';

const track = (..._values: unknown[]) => _values.length;
const DESKTOP_ROW_HEIGHT = 43;
const DESKTOP_OVERSCAN_ROWS = 8;
const DESKTOP_MAX_WINDOW_ROWS = 300;
const DESKTOP_PAGE_PREFETCH_ROWS = 12;
const MOBILE_ROW_HEIGHT = 188;
const MOBILE_OVERSCAN_ROWS = 8;
const MOBILE_MAX_WINDOW_ROWS = 600;
const MOBILE_PAGE_PREFETCH_PX = MOBILE_ROW_HEIGHT * 3;
const MIN_SESSION_TABLE_WIDTH = 720;
const SESSION_VIEWPORT_FALLBACK_HEIGHT = 520;

interface SessionVirtualRow<RowValue> {
  index: number;
  row: RowValue;
}

interface SessionVirtualWindow<RowValue> {
  bottomHeight: number;
  lastIndex: number;
  rows: SessionVirtualRow<RowValue>[];
  topHeight: number;
}

const createSessionVirtualSurface = <Element extends HTMLElement, RowValue>(options: {
  active: Accessor<boolean>;
  maxRows: number;
  metricName: string;
  overscanRows: number;
  rowHeight: number;
  rows: Accessor<RowValue[]>;
}) => {
  const [element, setElement] = createSignal<Element>();
  const [viewport, setViewport] = createSignal({ height: SESSION_VIEWPORT_FALLBACK_HEIGHT, scrollTop: 0 });
  const updateViewport = (): void => {
    const currentElement = element();
    const next = {
      height: currentElement?.clientHeight || SESSION_VIEWPORT_FALLBACK_HEIGHT,
      scrollTop: currentElement?.scrollTop ?? 0,
    };
    setViewport((current) => (current.height === next.height && current.scrollTop === next.scrollTop ? current : next));
  };
  const rowWindow = createMemo<SessionVirtualWindow<RowValue>>(() => {
    const rows = options.rows();
    if (!options.active()) {
      return { bottomHeight: 0, lastIndex: -1, rows: [], topHeight: 0 };
    }
    const currentViewport = viewport();
    const window = calculateSessionRowWindow({
      maxRows: options.maxRows,
      overscanRows: options.overscanRows,
      rowCount: rows.length,
      rowHeight: options.rowHeight,
      scrollTop: currentViewport.scrollTop,
      viewportHeight: currentViewport.height,
    });
    return measureClientPerf(
      options.metricName,
      () => ({
        bottomHeight: window.bottomHeight,
        lastIndex: window.endIndex - 1,
        rows: rows
          .slice(window.startIndex, window.endIndex)
          .map((row, index) => ({ index: window.startIndex + index, row })),
        topHeight: window.topHeight,
      }),
      (result) => ({ rows: result.rows.length }),
    );
  });

  createEffect(() => {
    const currentElement = element();
    if (!(currentElement && options.active())) {
      return;
    }
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(currentElement);
    onCleanup(() => observer.disconnect());
  });

  return {
    element,
    reset: (): void => {
      element()?.scrollTo({ top: 0 });
      updateViewport();
    },
    rowWindow,
    setElement,
    updateViewport,
  };
};

const MobileSessionSummary = (props: {
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onHarnessFilter: (value: string) => void;
  onSelect: (row: DashboardRow) => void;
  position: number;
  searchQuery: string;
  selected: boolean;
  tableRow: Row<DashboardRow>;
  total: number;
}) => {
  const row = () => props.tableRow.original;
  const apiValue = () => apiValuePresentation(row());
  const rootSessionOnly = () => row().campaignTotalCount !== undefined;
  const durationSemantics = () => sessionDurationSemantics(row().source?.harnessKey, rootSessionOnly());

  return (
    <li
      aria-posinset={props.position}
      aria-setsize={props.total}
      class={sessionSummaryRow}
      data-index={props.position - 1}
      data-session-row-id={row().rowId}
    >
      <article class={sessionSummaryCard} data-depth={props.tableRow.depth} data-selected={String(props.selected)}>
        <header class={sessionSummaryHeader}>
          <span class={sessionSummaryDate}>{fmtDate(row().activeDate)}</span>
          <HarnessBadge name={row().harness} onClick={() => props.onHarnessFilter(row().harness)} />
        </header>
        <button
          aria-label={`Inspect session: ${row().sessionLabel}`}
          class={sessionSummaryOpen}
          onClick={() => props.onSelect(row())}
          type="button"
        >
          <span class={sessionSummaryTitle}>
            <HighlightedText query={props.searchQuery} text={row().sessionLabel} />
          </span>
          <span class={sessionSummaryValue} title={row().usageUnavailable ? USAGE_UNAVAILABLE_HINT : apiValue().title}>
            {row().usageUnavailable ? '—' : apiValue().label}
          </span>
        </button>
        <footer class={sessionSummaryFooter}>
          <div class={sessionSummaryFilters}>
            <button
              class={sessionSummaryFilter}
              onClick={() => props.onFieldFilter('project', row().projectKey)}
              title={`Filter by project ${row().projectKey}`}
              type="button"
            >
              {row().projectLabel === '(unknown)' ? 'No project' : row().projectLabel}
            </button>
            <button
              class={sessionSummaryFilter}
              onClick={() => props.onFieldFilter('model', row().modelKey)}
              title={`Filter by model ${row().modelKey}`}
              type="button"
            >
              {row().modelLabel}
            </button>
            <Show when={props.tableRow.getCanExpand()}>
              <button
                class={sessionSummaryFilter}
                onClick={() => props.tableRow.toggleExpanded()}
                title={props.tableRow.getIsExpanded() ? 'Collapse campaign' : 'Expand campaign'}
                type="button"
              >
                {props.tableRow.getIsExpanded() ? 'Hide children' : 'Show children'}
              </button>
            </Show>
          </div>
          <span class={sessionSummaryStats}>
            {fmtCompact(row().freshTokens)} fresh · {fmtCompact(row().tokCr)} cache ·{' '}
            <span title={durationSemantics().metricHint}>
              {fmtDuration(row().durationMs)}
              {rootSessionOnly() ? ' root' : ''}
            </span>
          </span>
        </footer>
      </article>
    </li>
  );
};

const SortHeader = (props: { column: Column<DashboardRow, unknown>; label: string }) => {
  const meta = () => props.column.columnDef.meta;
  const sortDirection = () => props.column.getIsSorted();

  return (
    <Show fallback={<span class={meta()?.headerClass}>{props.label}</span>} when={props.column.getCanSort()}>
      <button
        class={cx(sortButton, meta()?.headerClass)}
        onClick={(event) => props.column.getToggleSortingHandler()?.(event)}
        title={meta()?.title}
        type="button"
      >
        <span>{props.label}</span>
        <Show when={sortDirection()}>
          {(direction) => (
            <span aria-hidden="true" class={sortArrow}>
              {direction() === 'asc' ? '↑' : '↓'}
            </span>
          )}
        </Show>
      </button>
    </Show>
  );
};

// Folded into a disclosure: column tuning is an occasional task, so it should
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
    <Popover
      contentClass={popoverContent}
      trigger={<span>Advanced columns · {visibleCount()} ▾</span>}
      triggerClass={ghostButton}
    >
      <div class={popoverHeader}>
        <span>
          {visibleCount()} of {sessionColumns.length} columns shown
        </span>
        <button
          class={ghostButton}
          onClick={() => props.onColumnVisibilityChange(defaultColumnVisibility)}
          type="button"
        >
          Reset
        </button>
      </div>
      <div class={popoverGrid}>
        <For each={hideableColumns()}>
          {(column) => (
            <Checkbox
              checked={isSessionColumnVisible(props.columnVisibility, column.id)}
              onCheckedChange={(checked) => setColumnVisible(column.id, checked)}
            >
              {sessionColumnLabel(column)}
            </Checkbox>
          )}
        </For>
      </div>
    </Popover>
  );
};

const SessionColumnControls = (props: {
  columnVisibility: VisibilityState;
  hiddenColumnIds?: string[];
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
}) => {
  const activePreset = () => sessionColumnPresetForVisibility(props.columnVisibility);

  return (
    <fieldset aria-label="Session column presets" class={presetGroup}>
      <For each={sessionColumnPresets}>
        {(preset) => {
          const active = () => activePreset() === preset.id;
          return (
            <button
              aria-pressed={active()}
              class={presetButton}
              data-active={String(active())}
              onClick={() => props.onColumnVisibilityChange(columnVisibilityForSessionPreset(preset.id))}
              type="button"
            >
              {preset.label}
            </button>
          );
        }}
      </For>
      <ColumnVisibilityControl
        columnVisibility={props.columnVisibility}
        onColumnVisibilityChange={props.onColumnVisibilityChange}
        {...(props.hiddenColumnIds ? { hiddenColumnIds: props.hiddenColumnIds } : {})}
      />
    </fieldset>
  );
};

export const SessionTable = (props: {
  campaignChildren?: ReadonlyMap<string, { loading: boolean; nextCursor: string | null }>;
  columnVisibility: VisibilityState;
  groupCampaigns: boolean;
  hasMoreRows?: boolean;
  loading?: boolean;
  loadingMoreRows?: boolean;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
  onClearFilters: () => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onGroupCampaignsChange: (enabled: boolean) => void;
  onHarnessFilter: (value: string) => void;
  onLoadCampaignChildren?: (campaignKey: string) => void;
  onLoadMoreRows?: () => void;
  onSelect: (row: DashboardRow) => void;
  onSortingChange: OnChangeFn<SortingState>;
  queryResetKey: string;
  rows: DashboardRow[];
  searchQuery: string;
  selectedKey: string | null;
  sorting: SortingState;
  totalRows?: number;
}) => {
  // A column whose every visible row reads "—" is dead weight; RTK savings
  // only earns its slot when the filtered set actually carries RTK data.
  // Folding this into the visibility state keeps headers and cells in sync.
  const [expanded, setExpanded] = createSignal<ExpandedState>({});
  const [surfaceMode, setSurfaceMode] = createSignal<SessionSurfaceMode>('pending');
  const tableData = createMemo(() => props.rows);
  const hasRtkData = createMemo(() => tableData().some((row) => row.rtkSavedTokens));
  const effectiveVisibility = createMemo(() =>
    hasRtkData() ? props.columnVisibility : { ...props.columnVisibility, rtkSaved: false },
  );
  const dataHiddenColumnIds = () => (hasRtkData() ? [] : ['rtkSaved']);
  const sessionTable = createSolidTable<DashboardRow>({
    get data() {
      return tableData();
    },
    columns: sessionColumns,
    get state() {
      return {
        sorting: props.sorting,
        columnVisibility: effectiveVisibility(),
        expanded: expanded(),
      };
    },
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.children ?? [],
    getRowCanExpand: (row) =>
      Boolean(
        row.original.children?.length ||
          (props.groupCampaigns && row.original.campaignKey && props.onLoadCampaignChildren),
      ),
    getRowId: (row) => rowKey(row),
    meta: {
      onFieldFilter: props.onFieldFilter,
      onHarnessFilter: props.onHarnessFilter,
      get searchQuery() {
        return props.searchQuery;
      },
    },
    onColumnVisibilityChange: props.onColumnVisibilityChange,
    onExpandedChange: (updater) =>
      setExpanded((current) => {
        const next = typeof updater === 'function' ? updater(current) : updater;
        if (typeof next !== 'object') {
          return next;
        }
        const currentRecord = typeof current === 'object' ? current : {};
        for (const [rowId, isExpanded] of Object.entries(next)) {
          if (!(isExpanded && !currentRecord[rowId])) {
            continue;
          }
          const campaignKey = props.rows.find((row) => rowKey(row) === rowId)?.campaignKey;
          if (campaignKey) {
            props.onLoadCampaignChildren?.(campaignKey);
          }
        }
        return next;
      }),
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
      MIN_SESSION_TABLE_WIDTH,
      visibleColumns().reduce((sum, { columnDef }) => sum + (columnDef.meta?.widthPx ?? 140), 0),
    );
  const rowModelRows = createMemo(() => {
    track(tableData(), props.sorting);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableRowModel',
      () => sessionTable.getRowModel().rows,
      (rows) => ({ rows: rows.length }),
    );
  });
  const visibleColumnCount = () => visibleColumns().length;
  const desktopVirtualSurface = createSessionVirtualSurface<HTMLDivElement, Row<DashboardRow>>({
    active: () => surfaceMode() === 'desktop',
    maxRows: DESKTOP_MAX_WINDOW_ROWS,
    metricName: 'aiUsage.web.client.compute.sessionTableVirtualRows',
    overscanRows: DESKTOP_OVERSCAN_ROWS,
    rowHeight: DESKTOP_ROW_HEIGHT,
    rows: rowModelRows,
  });
  const virtualRows = desktopVirtualSurface.rowWindow;
  const shouldLoadNextDesktopPage = createMemo(() => {
    if (surfaceMode() !== 'desktop' || !props.hasMoreRows || props.loadingMoreRows || !props.onLoadMoreRows) {
      return false;
    }
    return virtualRows().lastIndex >= rowModelRows().length - DESKTOP_PAGE_PREFETCH_ROWS;
  });
  const [mobilePagingEl, setMobilePagingEl] = createSignal<HTMLLIElement>();
  const [mobilePagingNearEnd, setMobilePagingNearEnd] = createSignal(false);
  const mobileVirtualSurface = createSessionVirtualSurface<HTMLUListElement, Row<DashboardRow>>({
    active: () => surfaceMode() === 'mobile',
    maxRows: MOBILE_MAX_WINDOW_ROWS,
    metricName: 'aiUsage.web.client.compute.sessionSummaryVirtualRows',
    overscanRows: MOBILE_OVERSCAN_ROWS,
    rowHeight: MOBILE_ROW_HEIGHT,
    rows: rowModelRows,
  });
  const mobileVirtualRows = mobileVirtualSurface.rowWindow;

  onMount(() => {
    const controller = createSessionSurfaceModeController(browserSessionSurfaceModeEnvironment());
    onCleanup(controller.start(setSurfaceMode));
  });

  createEffect(() => {
    const root = mobileVirtualSurface.element();
    const sentinel = mobilePagingEl();
    if (!(root && sentinel && surfaceMode() === 'mobile')) {
      setMobilePagingNearEnd(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setMobilePagingNearEnd(entries.some((entry) => entry.isIntersecting)),
      {
        root,
        rootMargin: `0px 0px ${MOBILE_PAGE_PREFETCH_PX}px 0px`,
      },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (surfaceMode() === 'mobile' && mobilePagingNearEnd() && props.hasMoreRows && !props.loadingMoreRows) {
      setMobilePagingNearEnd(false);
      props.onLoadMoreRows?.();
    }
  });

  createEffect(() => {
    if (shouldLoadNextDesktopPage()) {
      props.onLoadMoreRows?.();
    }
  });

  let previousQueryResetKey: string | undefined;
  createEffect(() => {
    const nextQueryResetKey = props.queryResetKey;
    if (nextQueryResetKey === previousQueryResetKey) {
      return;
    }
    previousQueryResetKey = nextQueryResetKey;
    setMobilePagingNearEnd(false);
    desktopVirtualSurface.reset();
    mobileVirtualSurface.reset();
  });

  const expandedCampaignLoads = createMemo(() => {
    const expansion = expanded();
    if (typeof expansion !== 'object') {
      return [];
    }
    return props.rows.flatMap((row) => {
      const campaignKey = row.campaignKey;
      if (!(campaignKey && expansion[rowKey(row)])) {
        return [];
      }
      const state = props.campaignChildren?.get(campaignKey);
      return state?.loading || state?.nextCursor
        ? [{ campaignKey, loading: state?.loading === true, sessionLabel: row.sessionLabel }]
        : [];
    });
  });

  createEffect(() => {
    if (!props.groupCampaigns) {
      setExpanded({});
      return;
    }
    const selectedKey = props.selectedKey;
    if (!selectedKey) {
      return;
    }
    const parent = props.rows.find((row) => row.children?.some((child) => rowKey(child) === selectedKey));
    if (!parent) {
      return;
    }
    setExpanded((current) => ({
      ...(typeof current === 'object' ? current : {}),
      [rowKey(parent)]: true,
    }));
  });

  const activeSort = () => props.sorting[0] ?? { desc: true, id: 'date' };

  return (
    <Show
      fallback={
        <Show
          fallback={
            <div class={empty}>
              <div class={emptyActions}>
                <span>No sessions match the current filters</span>
                <button class={ghostButton} onClick={() => props.onClearFilters()} type="button">
                  Clear filters
                </button>
              </div>
            </div>
          }
          when={props.loading}
        >
          <div aria-busy="true" aria-live="polite" class={empty}>
            Loading sessions…
          </div>
        </Show>
      }
      when={props.rows.length}
    >
      <div class={tableControls}>
        <Checkbox
          checked={props.groupCampaigns}
          onCheckedChange={(checked) => {
            props.onGroupCampaignsChange(checked);
            setExpanded({});
          }}
        >
          Group campaigns
        </Checkbox>
        <Show when={surfaceMode() === 'desktop'}>
          <div class={sessionDesktopControl}>
            <SessionColumnControls
              columnVisibility={props.columnVisibility}
              hiddenColumnIds={dataHiddenColumnIds()}
              onColumnVisibilityChange={props.onColumnVisibilityChange}
            />
          </div>
        </Show>
        <Show when={surfaceMode() === 'mobile'}>
          <div class={sessionSummaryMobileSort}>
            <label class={sessionSummaryMobileSortField}>
              <span>Sort by</span>
              <select
                aria-label="Sort mobile session summaries"
                class={sessionSummaryMobileSortSelect}
                onChange={(event) =>
                  props.onSortingChange([{ desc: activeSort().desc, id: event.currentTarget.value }])
                }
                value={activeSort().id}
              >
                <For each={sessionColumns}>
                  {(column) => <option value={column.id}>{sessionColumnLabel(column)}</option>}
                </For>
              </select>
            </label>
            <button
              aria-label={activeSort().desc ? 'Sort ascending' : 'Sort descending'}
              class={ghostButton}
              onClick={() => props.onSortingChange([{ desc: !activeSort().desc, id: activeSort().id }])}
              type="button"
            >
              {activeSort().desc ? 'Descending ↓' : 'Ascending ↑'}
            </button>
          </div>
        </Show>
      </div>
      <Show when={surfaceMode() === 'pending'}>
        <div aria-busy="true" class={tableWrap} data-session-surface="pending">
          Preparing sessions…
        </div>
      </Show>
      <Show when={surfaceMode() === 'desktop'}>
        <div
          class={cx(tableWrap, surfaceMode() === 'desktop' ? desktopTableSurface : undefined)}
          data-session-surface={surfaceMode()}
          onScroll={desktopVirtualSurface.updateViewport}
          ref={desktopVirtualSurface.setElement}
        >
          <table class={cx(table, sessionsTable)} style={{ 'min-width': `${tableMinWidth()}px` }}>
            <thead>
              <tr>
                <For each={visibleColumns()}>
                  {({ columnDef, tableColumn }) => (
                    <th
                      class={columnDef.meta?.headerClass}
                      style={{ width: `${columnDef.meta?.widthPx ?? 140}px` }}
                      title={columnDef.meta?.title}
                    >
                      <SortHeader column={tableColumn} label={sessionColumnHeader(columnDef)} />
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <Show when={virtualRows().topHeight > 0}>
                <tr data-virtual-spacer="top">
                  <td
                    colSpan={visibleColumnCount()}
                    style={{ height: `${virtualRows().topHeight}px`, padding: '0', border: '0' }}
                  />
                </tr>
              </Show>
              <For each={virtualRows().rows}>
                {(virtualRow) => {
                  const tableRow = virtualRow.row;
                  return (
                    <tr
                      data-depth={tableRow.depth}
                      data-index={virtualRow.index}
                      data-selected={String(props.selectedKey === tableRow.id)}
                      data-session-row-id={tableRow.original.rowId}
                      onClick={() => props.onSelect(tableRow.original)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) {
                          return;
                        }
                        if (event.key !== 'Enter' && event.key !== ' ') {
                          return;
                        }
                        event.preventDefault();
                        props.onSelect(tableRow.original);
                      }}
                      tabIndex={0}
                    >
                      <For each={tableRow.getVisibleCells()}>
                        {(cell) => (
                          <td class={cell.column.columnDef.meta?.cellClass}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        )}
                      </For>
                    </tr>
                  );
                }}
              </For>
              <Show when={virtualRows().bottomHeight > 0}>
                <tr data-virtual-spacer="bottom">
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
      <Show when={surfaceMode() === 'mobile'}>
        <ul
          aria-label="Session summaries"
          class={cx(mobileSummarySurface, sessionSummaryViewport)}
          data-session-surface="mobile"
          onScroll={mobileVirtualSurface.updateViewport}
          ref={mobileVirtualSurface.setElement}
        >
          <Show when={mobileVirtualRows().topHeight > 0}>
            <li
              aria-hidden="true"
              data-virtual-spacer="top"
              role="presentation"
              style={{ height: `${mobileVirtualRows().topHeight}px` }}
            />
          </Show>
          <For each={mobileVirtualRows().rows}>
            {(virtualRow) => (
              <MobileSessionSummary
                onFieldFilter={props.onFieldFilter}
                onHarnessFilter={props.onHarnessFilter}
                onSelect={props.onSelect}
                position={virtualRow.index + 1}
                searchQuery={props.searchQuery}
                selected={props.selectedKey === virtualRow.row.id}
                tableRow={virtualRow.row}
                total={Math.max(props.totalRows ?? rowModelRows().length, rowModelRows().length)}
              />
            )}
          </For>
          <Show when={mobileVirtualRows().bottomHeight > 0}>
            <li
              aria-hidden="true"
              data-virtual-spacer="bottom"
              role="presentation"
              style={{ height: `${mobileVirtualRows().bottomHeight}px` }}
            />
          </Show>
          <li
            aria-hidden="true"
            class={sessionSummaryLoadMore}
            data-session-paging-sentinel="mobile"
            ref={setMobilePagingEl}
            role="presentation"
            style={{ height: '1px', padding: '0' }}
          />
        </ul>
      </Show>
      <For each={expandedCampaignLoads()}>
        {(campaign) => (
          <div class={sessionPagingLoadMore}>
            <button
              aria-label={`Load more sessions in campaign ${campaign.sessionLabel}`}
              class={ghostButton}
              disabled={campaign.loading}
              onClick={() => props.onLoadCampaignChildren?.(campaign.campaignKey)}
              type="button"
            >
              {campaign.loading ? 'Loading campaign sessions…' : `Load more sessions in ${campaign.sessionLabel}`}
            </button>
          </div>
        )}
      </For>
      <Show when={props.loadingMoreRows}>
        <div aria-live="polite" class={sessionPagingLoadMore}>
          Loading more sessions…
        </div>
      </Show>
    </Show>
  );
};
