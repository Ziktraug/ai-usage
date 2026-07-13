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
import { createVirtualizer } from '@tanstack/solid-virtual';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { measureClientPerf } from './client-perf';
import type { FieldFilterKey } from './dashboard-search';
import { HighlightedText } from './highlighted-text';
import {
  defaultColumnVisibility,
  isSessionColumnVisible,
  type SessionColumnDef,
  sessionColumnHeader,
  sessionColumnLabel,
  sessionColumns,
  visibleSessionColumns,
} from './session-columns';
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
  type DashboardRow,
  fmtCompact,
  fmtDate,
  fmtDuration,
  fmtMoney,
  HarnessBadge,
  rowKey,
  UNKNOWN_PRICE_HINT,
} from './shared';

const track = (..._values: unknown[]) => _values.length;
const DESKTOP_ROW_HEIGHT = 43;
const MIN_SESSION_TABLE_WIDTH = 720;
const MOBILE_PAGE_SIZE = 50;

export const nextMobileSessionRowLimit = (currentLimit: number, totalRows: number) =>
  Math.min(totalRows, currentLimit + MOBILE_PAGE_SIZE);

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
  const apiValue = () => {
    if (row().usageUnavailable || !row().costKnown) {
      return '—';
    }
    return fmtMoney(row().costApprox);
  };

  return (
    <li aria-posinset={props.position} aria-setsize={props.total} class={sessionSummaryRow}>
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
          <span class={sessionSummaryValue} title={row().costKnown ? 'Estimated API value' : UNKNOWN_PRICE_HINT}>
            {apiValue()}
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
            {fmtCompact(row().freshTokens)} fresh · {fmtCompact(row().tokCr)} cache · {fmtDuration(row().durationMs)}
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
  const [desktopViewportEl, setDesktopViewportEl] = createSignal<HTMLDivElement>();
  const [mobileRowLimit, setMobileRowLimit] = createSignal(MOBILE_PAGE_SIZE);
  const rowModelRows = createMemo(() => {
    track(tableData(), props.sorting);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableRowModel',
      () => sessionTable.getRowModel().rows,
      (rows) => ({ rows: rows.length }),
    );
  });
  const mobileRows = createMemo(() => (surfaceMode() === 'mobile' ? rowModelRows().slice(0, mobileRowLimit()) : []));
  const remainingMobileRows = createMemo(() =>
    surfaceMode() === 'mobile' ? Math.max(0, rowModelRows().length - mobileRows().length) : 0,
  );
  const visibleColumnCount = () => visibleColumns().length;
  const rowVirtualizer = createVirtualizer({
    get count() {
      return rowModelRows().length;
    },
    get enabled() {
      return surfaceMode() === 'desktop' && Boolean(desktopViewportEl());
    },
    estimateSize: () => DESKTOP_ROW_HEIGHT,
    getScrollElement: () => desktopViewportEl() ?? null,
    initialRect: { height: 520, width: 0 },
    overscan: 8,
  });
  const virtualRows = createMemo(() => {
    const rows = rowModelRows();
    if (surfaceMode() !== 'desktop') {
      return {
        bottomHeight: 0,
        rows: [],
        topHeight: 0,
      };
    }
    const items = rowVirtualizer.getVirtualItems();
    const firstItem = items[0];
    const lastItem = items.at(-1);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableVirtualRows',
      () => ({
        bottomHeight: Math.max(0, rowVirtualizer.getTotalSize() - (lastItem?.end ?? 0)),
        rows: items.flatMap((item) => {
          const row = rows[item.index];
          return row ? [{ item, row }] : [];
        }),
        topHeight: firstItem?.start ?? 0,
      }),
      (result) => ({ rows: result.rows.length }),
    );
  });

  onMount(() => {
    const controller = createSessionSurfaceModeController(browserSessionSurfaceModeEnvironment());
    onCleanup(controller.start(setSurfaceMode));
  });

  createEffect(() => {
    track(tableData(), props.sorting);
    setMobileRowLimit(MOBILE_PAGE_SIZE);
    if (surfaceMode() === 'desktop') {
      rowVirtualizer.scrollToOffset(0);
    }
  });

  createEffect(() => {
    if (surfaceMode() !== 'mobile') {
      return;
    }
    const selectedKey = props.selectedKey;
    if (!selectedKey) {
      return;
    }
    const selectedIndex = rowModelRows().findIndex((row) => row.id === selectedKey);
    if (selectedIndex >= mobileRowLimit()) {
      setMobileRowLimit(selectedIndex + 1);
    }
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
          ref={(element) => {
            setDesktopViewportEl(element);
            queueMicrotask(() => rowVirtualizer.measure());
          }}
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
                  const tableRow = 'row' in virtualRow ? virtualRow.row : virtualRow;
                  const virtualItem = 'item' in virtualRow ? virtualRow.item : null;
                  return (
                    <tr
                      data-depth={tableRow.depth}
                      data-index={virtualItem?.index}
                      data-selected={String(props.selectedKey === tableRow.id)}
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
                      ref={(element) => {
                        if (!virtualItem) {
                          return;
                        }
                        queueMicrotask(() => {
                          if (element.isConnected) {
                            rowVirtualizer.measureElement(element);
                          }
                        });
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
        >
          <For each={mobileRows()}>
            {(tableRow, index) => (
              <MobileSessionSummary
                onFieldFilter={props.onFieldFilter}
                onHarnessFilter={props.onHarnessFilter}
                onSelect={props.onSelect}
                position={index() + 1}
                searchQuery={props.searchQuery}
                selected={props.selectedKey === tableRow.id}
                tableRow={tableRow}
                total={props.totalRows ?? rowModelRows().length}
              />
            )}
          </For>
        </ul>
        <Show when={remainingMobileRows() > 0}>
          <div class={sessionSummaryLoadMore}>
            <button
              class={ghostButton}
              onClick={() => setMobileRowLimit((limit) => nextMobileSessionRowLimit(limit, rowModelRows().length))}
              type="button"
            >
              Show {Math.min(MOBILE_PAGE_SIZE, remainingMobileRows())} more · {remainingMobileRows()} remaining
            </button>
          </div>
        </Show>
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
      <Show
        when={
          props.hasMoreRows &&
          (surfaceMode() === 'desktop' ||
            surfaceMode() === 'pending' ||
            (surfaceMode() === 'mobile' && remainingMobileRows() === 0))
        }
      >
        <div class={sessionPagingLoadMore}>
          <button
            class={ghostButton}
            disabled={props.loadingMoreRows}
            onClick={() => props.onLoadMoreRows?.()}
            type="button"
          >
            {props.loadingMoreRows ? 'Loading more sessions…' : 'Load more sessions'}
          </button>
        </div>
      </Show>
    </Show>
  );
};
