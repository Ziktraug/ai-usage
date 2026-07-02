import { type AnalyticsSummary, calculateAnalytics } from './analytics';
import type { ReportDatasets } from './datasets';
import type { ProjectGroupConfig, ProjectGroupingWarningReason, ProjectSourceSelector } from './project-group';
import type { UsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';
import { usageRowActiveDate, usageRowLineDelta, usageRowSessionLabel, usageRowTokenTotal } from './usage-row';

export type SortKey = 'date' | 'tokens' | 'cost';

export interface ReportOptions {
  limit: number | null;
  minTokens: number;
  project: string | null;
  since: Date | null;
  sort: SortKey;
}

export interface PreparedUsageReport {
  omittedRows: number;
  rows: UsageRow[];
  tableRows: UsageRow[];
}

export interface SerializedUsageRow extends Omit<UsageRow, 'date' | 'endDate'> {
  activeDate: string | null;
  date: string | null;
  endDate: string | null;
  freshTokens: number;
  lineDelta: number | null;
  projectGroupId?: string;
  projectSourceId?: string;
  rawProject?: string;
  sessionLabel: string;
  source?: UsageRowSource;
  tokenTotal: number;
}

export type SerializedRow = SerializedUsageRow;

export interface UsageReportWarning {
  groupId?: string;
  groupName?: string;
  harness?: string;
  message: string;
  operation?: string;
  path?: string;
  reason?: ProjectGroupingWarningReason;
  selectors?: ProjectSourceSelector[];
  sql?: string;
}

export interface UsageReportProjectSource {
  gitRemote: string;
  id: string;
  machineId: string;
  machineLabel: string;
  project: string;
  sessions: number;
  sourcePath: string;
  tokens: number;
}

export interface UsageReportProjectGroup {
  cache: number;
  cost: number;
  fresh: number;
  grouped: boolean;
  id: string;
  linesAdded: number;
  linesDeleted: number;
  name: string;
  priced: number;
  sessions: number;
  sources: UsageReportProjectSource[];
  tokens: number;
  tools: number;
  turns: number;
}

export interface UsageReportPayload {
  analytics: AnalyticsSummary;
  datasets?: ReportDatasets;
  facets?: Record<string, unknown>;
  filters: {
    since: string | null;
    project: string | null;
    limit: number | null;
    minTokens: number;
    sort: SortKey;
  };
  generatedAt: string;
  omittedRows: number;
  projectGroupConfigs?: ProjectGroupConfig[];
  projectGroups?: UsageReportProjectGroup[];
  rows: SerializedUsageRow[];
  tableRows: SerializedUsageRow[];
  warnings?: UsageReportWarning[];
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
    if (usageRowTokenTotal(row) < options.minTokens && !row.usageUnavailable) {
      return false;
    }
    if (options.since && (!activeAt || activeAt < options.since)) {
      return false;
    }
    if (options.project && !row.project.toLowerCase().includes(options.project)) {
      return false;
    }
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
  const projectMetadata = row as UsageRowWithOptionalSource & {
    projectGroupId?: string;
    projectSourceId?: string;
    rawProject?: string;
  };
  return {
    ...row,
    date: row.date?.toISOString() ?? null,
    endDate: row.endDate?.toISOString() ?? null,
    activeDate: usageRowActiveDate(row)?.toISOString() ?? null,
    sessionLabel: usageRowSessionLabel(row),
    tokenTotal,
    freshTokens: row.tokIn + row.tokOut + row.tokCw,
    lineDelta: lineDelta.present ? lineDelta.total : null,
    ...(projectMetadata.rawProject === undefined ? {} : { rawProject: projectMetadata.rawProject }),
    ...(projectMetadata.projectGroupId === undefined ? {} : { projectGroupId: projectMetadata.projectGroupId }),
    ...(projectMetadata.projectSourceId === undefined ? {} : { projectSourceId: projectMetadata.projectSourceId }),
    ...(source ? { source } : {}),
  };
};

export const createUsageReportPayload = (
  report: PreparedUsageReport,
  options: ReportOptions,
  generatedAt = new Date(),
  facets?: Record<string, unknown>,
  warnings?: UsageReportWarning[],
  projectGroups?: UsageReportProjectGroup[],
  projectGroupConfigs?: ProjectGroupConfig[],
  datasets?: ReportDatasets,
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
  ...(projectGroups === undefined ? {} : { projectGroups }),
  ...(projectGroupConfigs === undefined ? {} : { projectGroupConfigs }),
  ...(warnings?.length ? { warnings } : {}),
  ...(datasets && Object.keys(datasets).length ? { datasets } : {}),
  ...(facets && Object.keys(facets).length ? { facets } : {}),
});
