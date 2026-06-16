import { type AnalyticsSummary, calculateAnalytics } from './analytics';
import type { Row, SourcedRow, UsageRowSource } from './types';
import { usageRowActiveDate, usageRowLineDelta, usageRowSessionLabel, usageRowTokenTotal } from './usage-row';

export type SortKey = 'date' | 'tokens' | 'cost';

export interface ReportOptions {
  since: Date | null;
  project: string | null;
  limit: number | null;
  minTokens: number;
  sort: SortKey;
}

export interface PreparedUsageReport {
  rows: Row[];
  tableRows: Row[];
  omittedRows: number;
}

export interface SerializedRow extends Omit<Row, 'date' | 'endDate'> {
  date: string | null;
  endDate: string | null;
  activeDate: string | null;
  sessionLabel: string;
  tokenTotal: number;
  freshTokens: number;
  lineDelta: number | null;
  source?: UsageRowSource;
}

export interface UsageReportPayload {
  generatedAt: string;
  filters: {
    since: string | null;
    project: string | null;
    limit: number | null;
    minTokens: number;
    sort: SortKey;
  };
  rows: SerializedRow[];
  tableRows: SerializedRow[];
  omittedRows: number;
  analytics: AnalyticsSummary;
  facets?: Record<string, unknown>;
}

export const compareUsageRows = (sort: SortKey) =>
  ({
    date: (a: Row, b: Row) => (usageRowActiveDate(b)?.getTime() ?? 0) - (usageRowActiveDate(a)?.getTime() ?? 0),
    tokens: (a: Row, b: Row) => usageRowTokenTotal(b) - usageRowTokenTotal(a),
    cost: (a: Row, b: Row) => b.costApprox - a.costApprox,
  })[sort];

export const filterUsageRows = (rows: Row[], options: ReportOptions) =>
  rows.filter((row) => {
    const activeAt = usageRowActiveDate(row);
    if (usageRowTokenTotal(row) < options.minTokens && !row.usageUnavailable) return false;
    if (options.since && (!activeAt || activeAt < options.since)) return false;
    if (options.project && !row.project.toLowerCase().includes(options.project)) return false;
    return true;
  });

export const prepareUsageReport = (rows: Row[], options: ReportOptions): PreparedUsageReport => {
  const filteredRows = filterUsageRows(rows, options).sort(compareUsageRows(options.sort));
  const tableRows = options.limit ? filteredRows.slice(0, options.limit) : filteredRows;
  return {
    rows: filteredRows,
    tableRows,
    omittedRows: filteredRows.length - tableRows.length,
  };
};

export const serializeUsageRow = (row: Row): SerializedRow => {
  const lineDelta = usageRowLineDelta(row);
  const tokenTotal = usageRowTokenTotal(row);
  const source = (row as Partial<SourcedRow>).source;
  return {
    ...row,
    date: row.date?.toISOString() ?? null,
    endDate: row.endDate?.toISOString() ?? null,
    activeDate: usageRowActiveDate(row)?.toISOString() ?? null,
    sessionLabel: usageRowSessionLabel(row),
    tokenTotal,
    freshTokens: row.tokIn + row.tokOut + row.tokCw,
    lineDelta: lineDelta.present ? lineDelta.total : null,
    ...(source ? { source } : {}),
  };
};

export const createUsageReportPayload = (
  report: PreparedUsageReport,
  options: ReportOptions,
  generatedAt = new Date(),
  facets?: Record<string, unknown>,
): UsageReportPayload => ({
  generatedAt: generatedAt.toISOString(),
  filters: {
    since: options.since?.toISOString() ?? null,
    project: options.project,
    limit: options.limit,
    minTokens: options.minTokens,
    sort: options.sort,
  },
  rows: report.rows.map(serializeUsageRow),
  tableRows: report.tableRows.map(serializeUsageRow),
  omittedRows: report.omittedRows,
  analytics: calculateAnalytics(report.rows, generatedAt.getTime()),
  ...(facets && Object.keys(facets).length ? { facets } : {}),
});
