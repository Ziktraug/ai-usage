export interface SessionTableAnchor {
  readonly focusedRowId: string | null;
  readonly index: number;
  readonly offset: number;
  readonly rowId: string;
}

export const captureSessionTableAnchor = (surface: HTMLElement): SessionTableAnchor | null => {
  const top = surface.getBoundingClientRect().top;
  const visibleTop = Math.max(top, surface.querySelector('thead')?.getBoundingClientRect().bottom ?? top);
  const row = [...surface.querySelectorAll<HTMLElement>('[data-session-row-id]')].find(
    (element) => element.getBoundingClientRect().bottom > visibleTop + 1,
  );
  const rowId = row?.dataset.sessionRowId;
  if (!(row && rowId)) {
    return null;
  }
  const focused = document.activeElement?.closest<HTMLElement>('[data-session-row-id]');
  return {
    focusedRowId: focused && surface.contains(focused) ? (focused.dataset.sessionRowId ?? null) : null,
    index: Number(row.dataset.index),
    offset: row.getBoundingClientRect().top - top,
    rowId,
  };
};

export const restoreSessionTableAnchor = (surface: HTMLElement, anchor: SessionTableAnchor, rowId: string): void => {
  const row = surface.querySelector<HTMLElement>(`[data-session-row-id="${CSS.escape(rowId)}"]`);
  if (row) {
    surface.scrollTop += row.getBoundingClientRect().top - surface.getBoundingClientRect().top - anchor.offset;
  }
  if (anchor.focusedRowId === null || surface.contains(document.activeElement)) {
    return;
  }
  const focusedRow =
    surface.querySelector<HTMLElement>(`[data-session-row-id="${CSS.escape(anchor.focusedRowId)}"]`) ?? row;
  const control = focusedRow?.matches('[data-session-index]')
    ? focusedRow
    : focusedRow?.querySelector<HTMLElement>('[data-session-index]');
  control?.focus({ preventScroll: true });
};
