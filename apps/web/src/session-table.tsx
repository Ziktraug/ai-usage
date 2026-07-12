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
  rows: DashboardRow[];
  groupCampaigns: boolean;
  selectedKey: string | null;
  searchQuery: string;
  sorting: SortingState;
  columnVisibility: VisibilityState;
  onSortingChange: OnChangeFn<SortingState>;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
  onGroupCampaignsChange: (enabled: boolean) => void;
  onSelect: (row: DashboardRow) => void;
  onHarnessFilter: (value: string) => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onClearFilters: () => void;
}) => {
  // A column whose every visible row reads "—" is dead weight; RTK savings
  // only earns its slot when the filtered set actually carries RTK data.
  // Folding this into the visibility state keeps headers and cells in sync.
  const hasRtkData = createMemo(() => props.rows.some((row) => row.rtkSavedTokens));
  const [expanded, setExpanded] = createSignal<ExpandedState>({});
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
        expanded: expanded(),
      };
    },
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.children ?? [],
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
      setExpanded((current) => (typeof updater === 'function' ? updater(current) : updater)),
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
  let desktopViewportEl: HTMLDivElement | undefined;
  const overscanRows = 8;
  const [mobileRowLimit, setMobileRowLimit] = createSignal(MOBILE_PAGE_SIZE);
  const [tableViewport, setTableViewport] = createSignal({ height: 520, scrollTop: 0 });
  const updateTableViewport = () => {
    const next = {
      height: desktopViewportEl?.clientHeight || 520,
      scrollTop: desktopViewportEl?.scrollTop ?? 0,
    };
    setTableViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  };
  const rowModelRows = createMemo(() => {
    track(props.rows, props.sorting);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableRowModel',
      () => sessionTable.getRowModel().rows,
      (rows) => ({ rows: rows.length }),
    );
  });
  const mobileRows = createMemo(() => rowModelRows().slice(0, mobileRowLimit()));
  const remainingMobileRows = createMemo(() => Math.max(0, rowModelRows().length - mobileRows().length));
  const visibleColumnCount = () => visibleColumns().length;
  const virtualRows = createMemo(() => {
    const rows = rowModelRows();
    const viewport = tableViewport();
    const virtualRowHeight = DESKTOP_ROW_HEIGHT;
    const start = Math.max(0, Math.floor(viewport.scrollTop / virtualRowHeight) - overscanRows);
    const end = Math.min(rows.length, start + Math.ceil(viewport.height / virtualRowHeight) + overscanRows * 2);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableVirtualRows',
      () => ({
        bottomHeight: Math.max(0, rows.length - end) * virtualRowHeight,
        rows: rows.slice(start, end),
        topHeight: start * virtualRowHeight,
      }),
      (result) => ({ rows: result.rows.length }),
    );
  });

  onMount(() => {
    updateTableViewport();
    const observer = new ResizeObserver(updateTableViewport);
    if (desktopViewportEl) {
      observer.observe(desktopViewportEl);
    }
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    track(props.rows, props.sorting);
    desktopViewportEl?.scrollTo({ top: 0 });
    setMobileRowLimit(MOBILE_PAGE_SIZE);
    updateTableViewport();
  });

  createEffect(() => {
    const selectedKey = props.selectedKey;
    if (!selectedKey) {
      return;
    }
    const selectedIndex = rowModelRows().findIndex((row) => row.id === selectedKey);
    if (selectedIndex >= mobileRowLimit()) {
      setMobileRowLimit(selectedIndex + 1);
    }
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
        <div class={empty}>
          <div class={emptyActions}>
            <span>No sessions match the current filters</span>
            <button class={ghostButton} onClick={() => props.onClearFilters()} type="button">
              Clear filters
            </button>
          </div>
        </div>
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
        <div class={sessionDesktopControl}>
          <SessionColumnControls
            columnVisibility={props.columnVisibility}
            hiddenColumnIds={dataHiddenColumnIds()}
            onColumnVisibilityChange={props.onColumnVisibilityChange}
          />
        </div>
        <div class={sessionSummaryMobileSort}>
          <label class={sessionSummaryMobileSortField}>
            <span>Sort by</span>
            <select
              aria-label="Sort mobile session summaries"
              class={sessionSummaryMobileSortSelect}
              onChange={(event) => props.onSortingChange([{ desc: activeSort().desc, id: event.currentTarget.value }])}
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
      </div>
      <div
        class={cx(tableWrap, desktopTableSurface)}
        onScroll={updateTableViewport}
        ref={(element) => {
          desktopViewportEl = element;
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
                  data-depth={tableRow.depth}
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
      <ul aria-label="Session summaries" class={cx(mobileSummarySurface, sessionSummaryViewport)}>
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
              total={rowModelRows().length}
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
  );
};
