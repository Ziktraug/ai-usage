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
import type { Column, OnChangeFn, SortingState, VisibilityState } from '@tanstack/solid-table';
import { createSolidTable, flexRender, getCoreRowModel, getSortedRowModel } from '@tanstack/solid-table';
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

const track = (..._values: unknown[]) => _values.length;

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
    <details>
      <summary class={ghostButton}>Columns · {visibleCount()} ▾</summary>
      <div class={popoverContent}>
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
              <label class={columnToggle}>
                <input
                  checked={isSessionColumnVisible(props.columnVisibility, column.id)}
                  class={columnToggleInput}
                  onChange={(event) => setColumnVisible(column.id, event.currentTarget.checked)}
                  type="checkbox"
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
    track(props.rows, props.sorting);
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
    if (tableViewportEl) {
      observer.observe(tableViewportEl);
    }
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    track(props.rows, props.sorting);
    if (tableViewportEl) {
      tableViewportEl.scrollTop = 0;
    }
    updateTableViewport();
  });

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
        <ColumnVisibilityControl
          columnVisibility={props.columnVisibility}
          hiddenColumnIds={dataHiddenColumnIds()}
          onColumnVisibilityChange={props.onColumnVisibilityChange}
        />
      </div>
      <div
        class={tableWrap}
        onScroll={updateTableViewport}
        ref={(element) => {
          tableViewportEl = element;
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
    </Show>
  );
};
