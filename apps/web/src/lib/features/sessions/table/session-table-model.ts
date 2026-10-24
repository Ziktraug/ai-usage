import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { constructTable, type ExpandedState, type Row } from '@tanstack/table-core';
import type { TableSortingState, TableVisibilityState } from '../../../foundation/table/state';
import { type SessionTableFeatures, sessionTableColumns, sessionTableFeatures } from './session-columns';

export interface SessionTableModelInput {
  readonly canLoadCampaignChildren?: boolean;
  readonly expanded: ExpandedState;
  readonly rows: SessionPresentationRow[];
  readonly sorting: TableSortingState;
  readonly visibility: TableVisibilityState;
}

export type SessionTableRow = Row<SessionTableFeatures, SessionPresentationRow>;

export interface SessionTableModel {
  readonly allRows: readonly SessionTableRow[];
  readonly rows: readonly SessionTableRow[];
}

/**
 * The adapter intentionally uses Table Core without a framework binding. The
 * server owns ordering; core owns stable row identity and expanded projections.
 * The component owns every state slice and rebuilds the model whenever one
 * changes, so table-internal state updates are never observed: nothing
 * subscribes to `table.store`, and no `on…Change` callback is registered.
 */
export const createSessionTableModel = (input: SessionTableModelInput): SessionTableModel => {
  const table = constructTable<SessionTableFeatures, SessionPresentationRow>({
    columns: [...sessionTableColumns],
    // Table Core reads this array; keep the caller-owned reference to avoid a full copy on each append.
    data: input.rows,
    enableMultiSort: false,
    enableSortingRemoval: false,
    features: sessionTableFeatures,
    getRowCanExpand: (row) =>
      Boolean(
        row.original.children?.length ||
          (row.original.campaignKey && input.canLoadCampaignChildren && (row.original.campaignTotalCount ?? 0) > 1),
      ),
    getRowId: (row) => row.rowId,
    getSubRows: (row) => row.children ?? [],
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
