import type { AnalyticsExportRow } from '@ai-usage/report-core/csv';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import type { ProjectGroup } from './dashboard-analytics';

export const createAnalyticsExport = async (
  dimension: 'harnesses' | 'models',
  generatedAt: string,
  rows: readonly AnalyticsExportRow[],
): Promise<{ csv: string; filename: string }> => {
  const { analyticsBreakdownCsv, reportCsvFilename } = await import('@ai-usage/report-core/csv');
  return {
    csv: analyticsBreakdownCsv(rows),
    filename: reportCsvFilename(dimension, generatedAt),
  };
};

/**
 * States the export's exact bound in the Sessions view, as persistent visible
 * text rather than a tooltip: it serializes the rows the browser has loaded, not
 * the whole filtered set, and a campaign travels as the single aggregated row
 * the table shows rather than as its child sessions. Both compositions render
 * this one sentence so the claim cannot drift between them.
 */
export const sessionsExportScopeLabel = (loadedRows: number, filteredSessions: number): string =>
  `Exports the ${loadedRows.toLocaleString()} loaded of ${filteredSessions.toLocaleString()} filtered sessions, campaigns as one aggregated row`;

/**
 * Row-level export of the session rows the browser currently holds. It feeds the
 * shared `usageRowCsvColumns` projection, so the emitted schema is identical to
 * the CLI's `--csv`; the web deliberately owns no column set of its own.
 *
 * The scope is the loaded rows, not the full filtered set — the honest
 * client-side bound, stated by `sessionsExportScopeLabel` next to the button.
 */
export const createSessionsExport = async (
  generatedAt: string,
  rows: readonly SessionPresentationRow[],
): Promise<{ csv: string; filename: string }> => {
  const { reportCsvFilename, serializedRowsToCSV } = await import('@ai-usage/report-core/csv');
  return {
    csv: serializedRowsToCSV([...rows]),
    filename: reportCsvFilename('sessions', generatedAt),
  };
};

export const createProjectExport = async (
  generatedAt: string,
  groups: readonly ProjectGroup[],
): Promise<{ csv: string; filename: string }> => {
  const { projectBreakdownCsv, reportCsvFilename } = await import('@ai-usage/report-core/csv');
  return {
    csv: projectBreakdownCsv(groups),
    filename: reportCsvFilename('projects', generatedAt),
  };
};
