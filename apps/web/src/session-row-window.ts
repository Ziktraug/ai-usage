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
  /** Document-relative top of the element the page is anchored to: 0 when the page must not scroll (desktop), the session region start on mobile. */
  anchorTop: number;
  /** Static document space below the session table owner (page padding, mobile navigation reserve). */
  bottomInset: number;
  minimumHeight: number;
  /** Document-relative top of the scroll surface (`rect.top + window.scrollY`) — scroll-invariant, so not circular. */
  surfaceTop: number;
  viewportHeight: number;
}

const nonNegativeInteger = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/**
 * The surface height uses document offsets, never the surface's current
 * position in the viewport. `surfaceTop` and `anchorTop` therefore do not
 * change while the page scrolls.
 *
 * Sizing it from its own `getBoundingClientRect().top` — as this did until
 * 2026-08-05, and as the retired Solid table did before it — is circular: the
 * height is part of the document, so scrolling down by one pixel moved the
 * surface up by one pixel, grew it by one pixel, grew the document by one pixel,
 * and the reader gained nothing. The page appeared to stretch away as you
 * scrolled, and the bottom stayed permanently out of reach until the surface
 * reached the top of the viewport.
 *
 * With `anchorTop = 0`, the resulting document height equals the viewport
 * height, so the page has no scroll range and the surface is the only scroll
 * container. A non-zero mobile anchor leaves only the range needed to bring the
 * session region to the top.
 */
export const calculateSessionViewportHeight = (input: SessionViewportHeightInput): number => {
  const viewportHeight = Math.max(1, nonNegativeInteger(input.viewportHeight));
  const chromeAboveSurface = Math.max(0, nonNegativeInteger(input.surfaceTop) - nonNegativeInteger(input.anchorTop));
  const bottomInset = nonNegativeInteger(input.bottomInset);
  const usableHeight = viewportHeight - chromeAboveSurface - bottomInset;
  // A viewport too short for the chrome plus the minimum keeps a usable surface
  // and lets the page scroll to it, rather than collapsing the table.
  return Math.max(Math.max(1, nonNegativeInteger(input.minimumHeight)), usableHeight);
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
