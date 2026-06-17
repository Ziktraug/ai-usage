import type { SerializedRow } from '@ai-usage/core/report-data';
import type { SortingState } from '@tanstack/solid-table';
import type { DashboardRow } from './shared';
import { fmtMaybeNum, fmtNum, fmtPct } from './shared';

export const sortValueForRow = (row: DashboardRow, columnId: string): number | string => {
  if (columnId === 'date') return row.sortDate;
  if (columnId === 'harness') return row.sortHarness;
  if (columnId === 'machine') return row.sortMachine;
  if (columnId === 'provider') return row.sortProvider;
  if (columnId === 'model') return row.sortModel;
  if (columnId === 'project') return row.sortProject;
  if (columnId === 'tokIn') return row.tokIn;
  if (columnId === 'tokOut') return row.tokOut;
  if (columnId === 'cache') return row.tokCr;
  if (columnId === 'tokCw') return row.tokCw;
  if (columnId === 'fresh') return row.freshTokens;
  if (columnId === 'total') return row.tokenTotal;
  if (columnId === 'cost') return row.costKnown ? row.costApprox : Number.NEGATIVE_INFINITY;
  if (columnId === 'actual') return row.costActual ?? Number.NEGATIVE_INFINITY;
  if (columnId === 'duration') return row.durationMs ?? 0;
  if (columnId === 'calls') return row.calls;
  if (columnId === 'turns') return row.turns;
  if (columnId === 'tools') return row.tools;
  if (columnId === 'lines') return row.lineDelta ?? 0;
  if (columnId === 'rtkSaved') return rtkSavingsPct(row) ?? 0;
  if (columnId === 'subagent') return row.subagent ? 1 : 0;
  if (columnId === 'partial') return row.partial ? 1 : 0;
  return row.sortSession;
};

export const compareRows = (sorting: SortingState) => (a: DashboardRow, b: DashboardRow) => {
  for (const sort of sorting) {
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
