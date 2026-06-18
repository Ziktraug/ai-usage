import { type AnalyticsSummary, calculateAnalytics } from './analytics';
import type { UsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';
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
  rows: UsageRow[];
  tableRows: UsageRow[];
  omittedRows: number;
}

export interface SerializedUsageRow extends Omit<UsageRow, 'date' | 'endDate'> {
  date: string | null;
  endDate: string | null;
  activeDate: string | null;
  sessionLabel: string;
  tokenTotal: number;
  freshTokens: number;
  lineDelta: number | null;
  source?: UsageRowSource;
}

export type SerializedRow = SerializedUsageRow;

export interface UsageReportWarning {
  harness?: string;
  operation?: string;
  path?: string;
  sql?: string;
  message: string;
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
  rows: SerializedUsageRow[];
  tableRows: SerializedUsageRow[];
  omittedRows: number;
  analytics: AnalyticsSummary;
  warnings?: UsageReportWarning[];
  facets?: Record<string, unknown>;
}

export const compareUsageRows = (sort: SortKey) =>
  ({
    date: (a: UsageRow, b: UsageRow) =>
      (usageRowActiveDate(b)?.getTime() ?? 0) - (usageRowActiveDate(a)?.getTime() ?? 0),
    tokens: (a: UsageRow, b: UsageRow) => usageRowTokenTotal(b) - usageRowTokenTotal(a),
    cost: (a: UsageRow, b: UsageRow) => b.costApprox - a.costApprox,
  })[sort];

export const filterUsageRows = (rows: UsageRow[], options: ReportOptions) =>
  rows.filter((row) => {
    const activeAt = usageRowActiveDate(row);
    if (usageRowTokenTotal(row) < options.minTokens && !row.usageUnavailable) return false;
    if (options.since && (!activeAt || activeAt < options.since)) return false;
    if (options.project && !row.project.toLowerCase().includes(options.project)) return false;
    return true;
  });

export const prepareUsageReport = (rows: UsageRow[], options: ReportOptions): PreparedUsageReport => {
  const filteredRows = filterUsageRows(rows, options).sort(compareUsageRows(options.sort));
  const tableRows = options.limit ? filteredRows.slice(0, options.limit) : filteredRows;
  return {
    rows: filteredRows,
    tableRows,
    omittedRows: filteredRows.length - tableRows.length,
  };
};

export const serializeUsageRow = (row: UsageRowWithOptionalSource): SerializedUsageRow => {
  const lineDelta = usageRowLineDelta(row);
  const tokenTotal = usageRowTokenTotal(row);
  const source = row.source;
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
  warnings?: UsageReportWarning[],
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
  ...(warnings?.length ? { warnings } : {}),
  ...(facets && Object.keys(facets).length ? { facets } : {}),
});
