import type { SerializedRow } from '@ai-usage/core/report-data';
import type { SortingState } from '@tanstack/solid-table';
import type { DashboardRow } from './shared';
import { fmtMaybeNum, fmtNum, fmtPct } from './shared';
import { isSessionColumnId, sortValueForSessionColumn, type SessionColumnId } from './session-table-schema';

export const sortValueForRow = (row: DashboardRow, columnId: SessionColumnId): number | string =>
  sortValueForSessionColumn(row, columnId);

export const compareRows = (sorting: SortingState) => (a: DashboardRow, b: DashboardRow) => {
  for (const sort of sorting) {
    if (!isSessionColumnId(sort.id)) continue;
    const av = sortValueForRow(a, sort.id);
    const bv = sortValueForRow(b, sort.id);
    const result =
      typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv))
        : av === bv
          ? 0
          : av > bv
            ? 1
            : -1;
    if (result !== 0) return sort.desc ? -result : result;
  }
  return 0;
};

export const lineDeltaLabel = (row: SerializedRow) => {
  if (row.lineDelta == null || row.lineDelta === 0) return '-';
  return `+${fmtMaybeNum(row.linesAdded)}/-${fmtMaybeNum(row.linesDeleted)}`;
};

export const rtkSavingsPct = (row: SerializedRow) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;

export const rtkSavedLabel = (row: SerializedRow) => {
  const pct = rtkSavingsPct(row);
  return pct == null ? '—' : fmtPct(pct);
};

export const rtkSavedTitle = (row: SerializedRow) =>
  row.rtkSavedTokens
    ? [
        `${fmtPct(rtkSavingsPct(row) ?? 0)} RTK savings`,
        `${fmtNum(row.rtkSavedTokens)} tokens saved`,
        `${fmtNum(row.rtkCommandCount ?? 0)} matched RTK commands`,
        `${fmtNum(row.rtkInputTokens ?? 0)} input tokens before filtering`,
        `${fmtNum(row.rtkOutputTokens ?? 0)} output tokens after filtering`,
        'Matched by project path and session time window',
      ].join('\n')
    : 'No matched RTK token savings';
