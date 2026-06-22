import { cx } from '@ai-usage/design-system/css';
import {
  columnToggle,
  columnToggleInput,
  columnToggleText,
  empty,
  emptyActions,
  ghostButton,
  popoverContent,
  popoverGrid,
  popoverHeader,
  sessionsTable,
  sortArrow,
  sortButton,
  table,
  tableControls,
  tableWrap,
} from '@ai-usage/design-system/report';
import type { Column, ExpandedState, OnChangeFn, SortingState, VisibilityState } from '@tanstack/solid-table';
import {
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
} from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { measureClientPerf } from './client-perf';
import type { FieldFilterKey } from './dashboard-search';
import {
  defaultColumnVisibility,
  isSessionColumnVisible,
  type SessionColumnDef,
  sessionColumnHeader,
  sessionColumnLabel,
  sessionColumns,
  visibleSessionColumns,
} from './session-columns';
import { type DashboardRow, rowKey } from './shared';

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
    <details>
      <summary class={ghostButton}>Columns · {visibleCount()} ▾</summary>
      <div class={popoverContent}>
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
      </div>
    </details>
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
    getSortedRowModel: getSortedRowModel(),
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
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableRowModel',
      () => sessionTable.getRowModel().rows,
      (rows) => ({ rows: rows.length }),
    );
  });
  const visibleColumnCount = () => visibleColumns().length;
  const virtualRows = createMemo(() => {
    const rows = rowModelRows();
    const viewport = tableViewport();
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscanRows);
    const end = Math.min(rows.length, start + Math.ceil(viewport.height / rowHeight) + overscanRows * 2);
    return measureClientPerf(
      'aiUsage.web.client.compute.sessionTableVirtualRows',
      () => ({
        bottomHeight: Math.max(0, rows.length - end) * rowHeight,
        rows: rows.slice(start, end),
        topHeight: start * rowHeight,
      }),
      (result) => ({ rows: result.rows.length }),
    );
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

  createEffect(() => {
    if (!props.groupCampaigns) {
      setExpanded({});
      return;
    }
    const selectedKey = props.selectedKey;
    if (!selectedKey) return;
    const parent = props.rows.find((row) => row.children?.some((child) => rowKey(child) === selectedKey));
    if (!parent) return;
    setExpanded((current) => ({
      ...(typeof current === 'object' ? current : {}),
      [rowKey(parent)]: true,
    }));
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
        <label class={columnToggle}>
          <input
            class={columnToggleInput}
            type="checkbox"
            checked={props.groupCampaigns}
            onChange={(event) => {
              props.onGroupCampaignsChange(event.currentTarget.checked);
              setExpanded({});
            }}
          />
          <span class={columnToggleText}>Group campaigns</span>
        </label>
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
                  data-depth={tableRow.depth}
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
