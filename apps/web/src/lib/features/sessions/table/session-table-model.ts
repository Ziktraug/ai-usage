import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { createTable, type ExpandedState, getCoreRowModel, getExpandedRowModel, type Row } from '@tanstack/table-core';
import type { TableSortingState, TableVisibilityState } from '../../../foundation/table/state';
import { sessionTableColumns } from './session-columns';

export interface SessionTableModelInput {
  readonly canLoadCampaignChildren?: boolean;
  readonly expanded: ExpandedState;
  readonly rows: SessionPresentationRow[];
  readonly sorting: TableSortingState;
  readonly visibility: TableVisibilityState;
}

export interface SessionTableModel {
  readonly allRows: readonly Row<SessionPresentationRow>[];
  readonly rows: readonly Row<SessionPresentationRow>[];
}

/**
 * The adapter intentionally uses Table Core without a framework binding. The
 * server owns ordering; core owns stable row identity and expanded projections.
 */
export const createSessionTableModel = (input: SessionTableModelInput): SessionTableModel => {
  const table = createTable<SessionPresentationRow>({
    columns: [...sessionTableColumns],
    // Table Core reads this array; keep the caller-owned reference to avoid a full copy on each append.
    data: input.rows,
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: (row) =>
      Boolean(row.original.children?.length || (row.original.campaignKey && input.canLoadCampaignChildren)),
    getRowId: (row) => row.rowId,
    getSubRows: (row) => row.children ?? [],
    onStateChange: () => undefined,
    renderFallbackValue: '',
    state: {
      columnVisibility: input.visibility,
      expanded: input.expanded,
      sorting: input.sorting,
    },
  });

  return {
    allRows: table.getCoreRowModel().flatRows,
    rows: table.getRowModel().rows,
  };
};

export const toggleSessionRowExpanded = (expanded: ExpandedState, rowId: string): ExpandedState => {
  const current = typeof expanded === 'object' ? expanded : {};
  return { ...current, [rowId]: !current[rowId] };
};
