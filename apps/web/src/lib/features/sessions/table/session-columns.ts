import { rtkSavingsPct } from '@ai-usage/report-core/csv';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import type { ColumnDef } from '@tanstack/table-core';
import { lineDeltaLabel } from '../../../../dashboard-sort';
import {
  isSessionColumnVisible,
  type SessionColumnId,
  sessionColumnSchema,
  sortValueForSessionColumn,
} from '../../../../session-table-schema';
import { fmtCompact, fmtDate, fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
import { apiValuePresentation } from '../../../foundation/presentation/report-value';

export interface SessionColumnMeta {
  readonly align: 'left' | 'right';
  readonly format: (row: SessionPresentationRow) => string;
  readonly label: string;
  readonly title?: string;
  readonly widthPx: number;
}

export type SessionTableColumn = ColumnDef<SessionPresentationRow, unknown> & {
  readonly id: SessionColumnId;
  readonly meta: SessionColumnMeta;
};

const unavailable = (row: SessionPresentationRow, value: string): string => (row.usageUnavailable ? '—' : value);
const boolLabel = (value: boolean | undefined): string => (value ? 'Yes' : 'No');
const token = (row: SessionPresentationRow, value: number): string => unavailable(row, fmtCompact(value));
const count = (row: SessionPresentationRow, value: number): string => unavailable(row, fmtNum(value));
const rtkLabel = (row: SessionPresentationRow): string => {
  const percentage = rtkSavingsPct(row);
  return percentage === null ? '—' : `${percentage.toFixed(percentage >= 10 ? 0 : 1)}%`;
};
const column = (
  id: SessionColumnId,
  header: string,
  meta: Omit<SessionColumnMeta, 'label'> & { readonly label?: string },
): SessionTableColumn => ({
  accessorFn: (row) => sortValueForSessionColumn(row, id),
  enableHiding: id !== 'session',
  header,
  id,
  meta: { ...meta, label: meta.label ?? header },
});

/**
 * Framework-neutral projection of the legacy 25-column contract. Table core
 * owns row identity/expansion while rendering remains a narrow Svelte concern.
 */
export const sessionTableColumns = [
  column('date', 'Date', { align: 'left', format: (row) => fmtDate(row.activeDate), widthPx: 104 }),
  column('session', 'Session', {
    align: 'left',
    format: (row) => row.sessionLabel,
    label: 'Session',
    widthPx: 260,
  }),
  column('harness', 'Harness', { align: 'left', format: (row) => row.harness, widthPx: 100 }),
  column('machine', 'Machine', {
    align: 'left',
    format: (row) => row.source?.machineLabel || '—',
    widthPx: 120,
  }),
  column('provider', 'Provider', { align: 'left', format: (row) => row.providerDisplay, widthPx: 124 }),
  column('project', 'Project', {
    align: 'left',
    format: (row) => (row.projectLabel === '(unknown)' ? '—' : row.projectLabel),
    widthPx: 120,
  }),
  column('model', 'Model', { align: 'left', format: (row) => row.modelLabel, widthPx: 168 }),
  column('tokIn', 'Input', {
    align: 'right',
    format: (row) => token(row, row.tokIn),
    label: 'Input tokens',
    widthPx: 90,
  }),
  column('tokOut', 'Output', {
    align: 'right',
    format: (row) => token(row, row.tokOut),
    label: 'Output tokens',
    widthPx: 94,
  }),
  column('cache', 'Cache', {
    align: 'right',
    format: (row) => token(row, row.tokCr),
    label: 'Cache read',
    title: 'Cache-read tokens',
    widthPx: 84,
  }),
  column('tokCw', 'Write', {
    align: 'right',
    format: (row) => token(row, row.tokCw),
    label: 'Cache write',
    title: 'Cache-write tokens',
    widthPx: 84,
  }),
  column('fresh', 'Fresh', {
    align: 'right',
    format: (row) => token(row, row.freshTokens),
    label: 'Fresh tokens',
    title: 'Tokens processed without cache (input + output + cache writes)',
    widthPx: 84,
  }),
  column('total', 'Total', {
    align: 'right',
    format: (row) => token(row, row.tokenTotal),
    label: 'Total tokens',
    widthPx: 90,
  }),
  column('rtkSaved', 'RTK', {
    align: 'right',
    format: rtkLabel,
    label: 'RTK savings',
    title: 'RTK saved-token percentage; hover a cell for matched command details',
    widthPx: 86,
  }),
  column('cost', 'API value', {
    align: 'right',
    format: (row) => unavailable(row, apiValuePresentation(row).label),
    title:
      'Estimated API-equivalent value at standard prices. Values prefixed with ≥ are lower bounds because some model prices are unavailable.',
    widthPx: 92,
  }),
  column('actual', '$Actual', {
    align: 'right',
    format: (row) => unavailable(row, fmtMoney(row.costActual)),
    label: 'Actual cost',
    title: 'Out-of-pocket spend reported by harnesses',
    widthPx: 88,
  }),
  column('quota', '$Sub', {
    align: 'right',
    format: (row) => unavailable(row, fmtMoney(row.costQuota)),
    label: 'Subscription value',
    title: 'Cursor export value covered by the subscription quota',
    widthPx: 86,
  }),
  column('duration', 'Time', {
    align: 'right',
    format: (row) => fmtDuration(row.durationMs),
    label: 'Recorded time',
    title: 'Harness-specific recorded or derived time; this is not model runtime',
    widthPx: 96,
  }),
  column('calls', 'Calls', { align: 'right', format: (row) => count(row, row.calls), widthPx: 76 }),
  column('turns', 'Turns', { align: 'right', format: (row) => count(row, row.turns), widthPx: 76 }),
  column('tools', 'Tools', { align: 'right', format: (row) => count(row, row.tools), widthPx: 76 }),
  column('lines', 'Lines', {
    align: 'right',
    format: lineDeltaLabel,
    label: 'Lines changed',
    widthPx: 96,
  }),
  column('subagent', 'Sub', {
    align: 'left',
    format: (row) => boolLabel(row.subagent),
    label: 'Subagent',
    widthPx: 72,
  }),
  column('partial', 'Partial', { align: 'left', format: (row) => boolLabel(row.partial), widthPx: 82 }),
  column('ambiguous', 'Ambiguous', {
    align: 'left',
    format: (row) => boolLabel(row.ambiguous),
    label: 'Ambiguous reconciliation',
    widthPx: 92,
  }),
] as const satisfies readonly SessionTableColumn[];

if (sessionTableColumns.length !== sessionColumnSchema.length) {
  throw new Error('The Svelte session table must preserve all 25 legacy columns');
}

export const visibleSessionTableColumns = (
  visibility: Readonly<Record<string, boolean>>,
): readonly SessionTableColumn[] => sessionTableColumns.filter((entry) => isSessionColumnVisible(visibility, entry.id));

export const sessionColumnById = (id: SessionColumnId): SessionTableColumn => {
  const entry = sessionTableColumns.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown session column: ${id}`);
  }
  return entry;
};
