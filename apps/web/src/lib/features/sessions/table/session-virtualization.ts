import { calculateSessionRowWindow } from '../../../../session-row-window';

export const sessionVirtualBudgets = {
  desktop: { maxRows: 300, overscanRows: 8, prefetchRows: 12, rowHeight: 43 },
  mobile: { maxRows: 600, overscanRows: 8, prefetchRows: 3, rowHeight: 188 },
} as const;

export interface SessionVirtualProjection<Row> {
  readonly bottomHeight: number;
  readonly endIndex: number;
  readonly rows: readonly { readonly index: number; readonly row: Row }[];
  readonly startIndex: number;
  readonly topHeight: number;
}

export const projectSessionVirtualRows = <Row>(input: {
  readonly mode: 'desktop' | 'mobile';
  readonly rows: readonly Row[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): SessionVirtualProjection<Row> => {
  const budget = sessionVirtualBudgets[input.mode];
  const window = calculateSessionRowWindow({
    maxRows: budget.maxRows,
    overscanRows: budget.overscanRows,
    rowCount: input.rows.length,
    rowHeight: budget.rowHeight,
    scrollTop: input.scrollTop,
    viewportHeight: input.viewportHeight,
  });
  return {
    ...window,
    rows: input.rows
      .slice(window.startIndex, window.endIndex)
      .map((row, offset) => ({ index: window.startIndex + offset, row })),
  };
};

export const isSessionPagePrefetchRequired = (input: {
  readonly endIndex: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly mode: 'desktop' | 'mobile';
  readonly rowCount: number;
}): boolean => {
  const { prefetchRows } = sessionVirtualBudgets[input.mode];
  return input.hasMore && !input.loading && input.endIndex >= input.rowCount - prefetchRows;
};
