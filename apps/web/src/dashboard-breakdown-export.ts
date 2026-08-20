import type { AnalyticsExportRow, SessionCampaignExportRow } from '@ai-usage/report-core/csv';
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

const loadedSessionCount = (rows: readonly SessionPresentationRow[]): number =>
  rows.reduce((sum, row) => sum + (row.campaignVisibleCount ?? 1), 0);

/**
 * States both pagination units instead of comparing top-level campaign rows to underlying sessions.
 * The reader can now tell whether the export is a complete campaign page and how many filtered
 * sessions those loaded campaign aggregates actually represent.
 */
export const sessionsExportScopeLabel = (
  rows: readonly SessionPresentationRow[],
  totalCampaignRows: number,
  filteredSessions: number,
): string =>
  `Exports ${rows.length.toLocaleString()} of ${totalCampaignRows.toLocaleString()} campaign rows currently loaded, representing ${loadedSessionCount(rows).toLocaleString()} of ${filteredSessions.toLocaleString()} filtered sessions`;

const sessionCampaignExportRow = (row: SessionPresentationRow): SessionCampaignExportRow => {
  if (row.campaignKey === undefined || row.campaignVisibleCount === undefined || row.campaignTotalCount === undefined) {
    throw new Error('Sessions export requires top-level campaign presentation rows.');
  }
  return {
    ambiguous: row.ambiguous ?? false,
    calls: row.calls,
    campaignKey: row.campaignKey,
    campaignLabel: row.sessionLabel,
    campaignSessions: row.campaignTotalCount,
    costActual: row.costActual,
    costApprox: row.costApprox,
    costKnown: row.costKnown,
    costQuota: row.costQuota,
    durationMs: row.durationMs,
    freshTokens: row.freshTokens,
    lineDelta: row.lineDelta,
    linesAdded: row.linesAdded,
    linesDeleted: row.linesDeleted,
    partial: row.partial ?? false,
    rtkCommandCount: row.rtkCommandCount,
    rtkInputTokens: row.rtkInputTokens,
    rtkOutputTokens: row.rtkOutputTokens,
    rtkSavedTokens: row.rtkSavedTokens,
    tokCr: row.tokCr,
    tokCw: row.tokCw,
    tokIn: row.tokIn,
    tokOut: row.tokOut,
    tokenTotal: row.tokenTotal,
    tools: row.tools,
    turns: row.turns,
    usageUnavailable: row.usageUnavailable ?? false,
    visibleSessions: row.campaignVisibleCount,
  };
};

/**
 * The Sessions table owns campaign display rows, not raw usage rows. Export them through a schema
 * that says exactly that: aggregate metrics plus campaign identity only. Root-only harness/model/
 * provider/machine/project fields are deliberately omitted because they can disagree with the child
 * rows contributing the filtered totals.
 */
export const createSessionsExport = async (
  generatedAt: string,
  rows: readonly SessionPresentationRow[],
): Promise<{ csv: string; filename: string }> => {
  const { reportCsvFilename, sessionCampaignCsv } = await import('@ai-usage/report-core/csv');
  return {
    csv: sessionCampaignCsv(rows.map(sessionCampaignExportRow)),
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
