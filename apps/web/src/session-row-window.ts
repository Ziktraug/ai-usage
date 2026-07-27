export interface SessionRowWindowInput {
  maxRows: number;
  overscanRows: number;
  rowCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
}

export interface SessionRowWindow {
  bottomHeight: number;
  endIndex: number;
  startIndex: number;
  topHeight: number;
}

export interface SessionViewportHeightInput {
  bottomInset: number;
  minimumHeight: number;
  surfaceTop: number;
  viewportHeight: number;
}

const nonNegativeInteger = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

export const calculateSessionViewportHeight = (input: SessionViewportHeightInput): number => {
  const viewportHeight = Math.max(1, nonNegativeInteger(input.viewportHeight));
  const bottomInset = Math.min(viewportHeight - 1, nonNegativeInteger(input.bottomInset));
  const usableHeight = viewportHeight - bottomInset;
  const minimumHeight = Math.min(usableHeight, Math.max(1, nonNegativeInteger(input.minimumHeight)));
  const surfaceTop = Number.isFinite(input.surfaceTop) ? input.surfaceTop : viewportHeight;

  if (surfaceTop >= viewportHeight) {
    return usableHeight;
  }

  const availableHeight = usableHeight - Math.max(0, surfaceTop);
  return Math.max(minimumHeight, availableHeight);
};

export const calculateSessionRowWindow = (input: SessionRowWindowInput): SessionRowWindow => {
  const rowCount = nonNegativeInteger(input.rowCount);
  if (rowCount === 0) {
    return { bottomHeight: 0, endIndex: 0, startIndex: 0, topHeight: 0 };
  }

  const rowHeight = Math.max(1, nonNegativeInteger(input.rowHeight));
  const viewportHeight = nonNegativeInteger(input.viewportHeight);
  const overscanRows = nonNegativeInteger(input.overscanRows);
  const maxRows = Math.max(1, nonNegativeInteger(input.maxRows));
  const maximumScrollTop = Math.max(0, rowCount * rowHeight - viewportHeight);
  const scrollTop = Math.min(maximumScrollTop, Math.max(0, input.scrollTop));
  const firstVisibleIndex = Math.min(rowCount - 1, Math.floor(scrollTop / rowHeight));
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const startIndex = Math.max(0, firstVisibleIndex - overscanRows);
  const uncappedEndIndex = Math.min(rowCount, firstVisibleIndex + visibleRowCount + overscanRows);
  const endIndex = Math.min(uncappedEndIndex, startIndex + maxRows);

  return {
    bottomHeight: (rowCount - endIndex) * rowHeight,
    endIndex,
    startIndex,
    topHeight: startIndex * rowHeight,
  };
};
