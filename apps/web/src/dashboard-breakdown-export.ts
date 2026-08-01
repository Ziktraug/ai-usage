import type { ProjectGroup } from './dashboard-analytics';
import type { AnalyticsExportRow } from './report-export';

export const createAnalyticsExport = async (
  dimension: 'harnesses' | 'models',
  generatedAt: string,
  rows: readonly AnalyticsExportRow[],
): Promise<{ csv: string; filename: string }> => {
  const { analyticsBreakdownCsv, reportCsvFilename } = await import('./report-export');
  return {
    csv: analyticsBreakdownCsv(rows),
    filename: reportCsvFilename(dimension, generatedAt),
  };
};

export const createProjectExport = async (
  generatedAt: string,
  groups: readonly ProjectGroup[],
): Promise<{ csv: string; filename: string }> => {
  const { projectBreakdownCsv, reportCsvFilename } = await import('./report-export');
  return {
    csv: projectBreakdownCsv(groups),
    filename: reportCsvFilename('projects', generatedAt),
  };
};
