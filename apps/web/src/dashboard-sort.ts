import { rtkSavingsPct as coreRtkSavingsPct } from '@ai-usage/report-core/csv';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  compareSessionPresentationRows,
  sortValueForSessionColumn as sortValueForCoreSessionColumn,
} from '@ai-usage/report-core/session-query';
import type { SortingState } from '@tanstack/solid-table';
import type { SessionColumnId } from './session-table-schema';
import type { DashboardRow } from './shared';
import { fmtMaybeNum, fmtNum, fmtPct } from './shared';

export const sortValueForRow = (row: DashboardRow, columnId: SessionColumnId): number | string =>
  sortValueForCoreSessionColumn(row, columnId);

export const compareRows = (sorting: SortingState) => compareSessionPresentationRows(sorting);

export const lineDeltaLabel = (row: SerializedRow) => {
  if (row.lineDelta == null || row.lineDelta === 0) {
    return '-';
  }
  return `+${fmtMaybeNum(row.linesAdded)}/-${fmtMaybeNum(row.linesDeleted)}`;
};

export const rtkSavingsPct = (row: SerializedRow) => coreRtkSavingsPct(row);

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
