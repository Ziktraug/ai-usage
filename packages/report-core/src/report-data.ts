import { type AnalyticsSummary, calculateAnalytics } from './analytics';
import type { ReportDatasets } from './datasets';
import {
  isProjectGroupConfigArray,
  type ProjectGroupConfig,
  type ProjectGroupingWarningReason,
  type ProjectSourceSelector,
} from './project-group';
import {
  hasOnlyKeys,
  isJsonSafeObject,
  isRecord,
  isSerializedUsageRow,
  isStrictIsoTimestamp,
  isUsageReportWarnings,
} from './serialized-usage-validation';
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

const REPORT_PAYLOAD_KEYS = new Set([
  'analytics',
  'datasets',
  'facets',
  'filters',
  'generatedAt',
  'omittedRows',
  'projectGroupConfigs',
  'projectGroups',
  'rows',
  'tableRows',
  'warnings',
]);
const REPORT_FILTER_KEYS = new Set(['limit', 'minTokens', 'project', 'since', 'sort']);
const ANALYTICS_KEYS = new Set([
  'averageDurationMs',
  'byHarness',
  'byModel',
  'byProvider',
  'costPer100Lines',
  'durationMs',
  'durationRows',
  'lineCount',
  'linesA',
  'linesD',
  'meanCost',
  'medianCost',
  'pricedCount',
  'recentSessions',
  'sessionCount',
  'tools',
  'totalCost',
  'turns',
  'unpricedCount',
]);
const ANALYTICS_GROUP_KEYS = new Set([
  'ambiguous',
  'cache',
  'cacheHitPct',
  'costPer100Lines',
  'costPercent',
  'costPerSession',
  'costSum',
  'fresh',
  'harness',
  'inp',
  'key',
  'lineCount',
  'linesA',
  'linesD',
  'medianCost',
  'priced',
  'provider',
  'sessions',
  'tools',
  'turns',
  'unpriced',
  'usageUnavailable',
]);
const PROJECT_GROUP_KEYS = new Set([
  'cache',
  'cost',
  'fresh',
  'grouped',
  'id',
  'linesAdded',
  'linesDeleted',
  'name',
  'priced',
  'sessions',
  'sources',
  'tokens',
  'tools',
  'turns',
]);
const PROJECT_SOURCE_KEYS = new Set([
  'gitRemote',
  'id',
  'machineId',
  'machineLabel',
  'project',
  'sessions',
  'sourcePath',
  'tokens',
]);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNullableFiniteNumber = (value: unknown): value is number | null => value === null || isFiniteNumber(value);
const isNonNegativeFiniteNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

const isAnalyticsGroup = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ANALYTICS_GROUP_KEYS) &&
  [value.key, value.harness, value.provider].every((field) => typeof field === 'string') &&
  [
    value.ambiguous,
    value.cache,
    value.fresh,
    value.inp,
    value.lineCount,
    value.linesA,
    value.linesD,
    value.priced,
    value.sessions,
    value.tools,
    value.turns,
    value.unpriced,
    value.usageUnavailable,
  ].every(isNonNegativeSafeInteger) &&
  [value.cacheHitPct, value.costPercent, value.costSum].every(isNonNegativeFiniteNumber) &&
  [value.costPer100Lines, value.costPerSession, value.medianCost].every(isNullableFiniteNumber);

const isUsageReportProjectSource = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, PROJECT_SOURCE_KEYS) &&
  [value.gitRemote, value.id, value.machineId, value.machineLabel, value.project, value.sourcePath].every(
    (field) => typeof field === 'string',
  ) &&
  [value.sessions, value.tokens].every(isNonNegativeSafeInteger);

const isUsageReportProjectGroup = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, PROJECT_GROUP_KEYS) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.grouped === 'boolean' &&
  [
    value.cache,
    value.fresh,
    value.linesAdded,
    value.linesDeleted,
    value.priced,
    value.sessions,
    value.tokens,
    value.tools,
    value.turns,
  ].every(isNonNegativeSafeInteger) &&
  isNonNegativeFiniteNumber(value.cost) &&
  Array.isArray(value.sources) &&
  value.sources.every(isUsageReportProjectSource);

const isReportFilters = (value: unknown): value is UsageReportPayload['filters'] =>
  isRecord(value) &&
  hasOnlyKeys(value, REPORT_FILTER_KEYS) &&
  (value.since === null || isStrictIsoTimestamp(value.since)) &&
  isNullableString(value.project) &&
  (value.limit === null || isNonNegativeSafeInteger(value.limit)) &&
  isNonNegativeSafeInteger(value.minTokens) &&
  (value.sort === 'date' || value.sort === 'tokens' || value.sort === 'cost');

const isAnalyticsSummary = (value: unknown): value is AnalyticsSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, ANALYTICS_KEYS) &&
  isNullableFiniteNumber(value.averageDurationMs) &&
  Array.isArray(value.byHarness) &&
  value.byHarness.every(isAnalyticsGroup) &&
  Array.isArray(value.byModel) &&
  value.byModel.every(isAnalyticsGroup) &&
  Array.isArray(value.byProvider) &&
  value.byProvider.every(isAnalyticsGroup) &&
  isNullableFiniteNumber(value.costPer100Lines) &&
  [
    value.durationMs,
    value.durationRows,
    value.lineCount,
    value.linesA,
    value.linesD,
    value.pricedCount,
    value.recentSessions,
    value.sessionCount,
    value.tools,
    value.turns,
    value.unpricedCount,
  ].every(isNonNegativeSafeInteger) &&
  [value.meanCost, value.medianCost, value.totalCost].every(isFiniteNumber);

const isUsageReportPayloadValue = (value: unknown): value is UsageReportPayload =>
  isRecord(value) &&
  isAnalyticsSummary(value.analytics) &&
  isReportFilters(value.filters) &&
  isStrictIsoTimestamp(value.generatedAt) &&
  isNonNegativeSafeInteger(value.omittedRows) &&
  Array.isArray(value.rows) &&
  value.rows.every((row) => isSerializedUsageRow(row)) &&
  Array.isArray(value.tableRows) &&
  value.tableRows.every((row) => isSerializedUsageRow(row)) &&
  (value.datasets === undefined || isJsonSafeObject(value.datasets)) &&
  (value.facets === undefined || isJsonSafeObject(value.facets)) &&
  (value.projectGroupConfigs === undefined || isProjectGroupConfigArray(value.projectGroupConfigs)) &&
  (value.projectGroups === undefined ||
    (Array.isArray(value.projectGroups) && value.projectGroups.every(isUsageReportProjectGroup))) &&
  (value.warnings === undefined || isUsageReportWarnings(value.warnings));

export const parseUsageReportPayload = (value: unknown): UsageReportPayload => {
  if (!(isRecord(value) && hasOnlyKeys(value, REPORT_PAYLOAD_KEYS))) {
    throw new Error('Report payload must be an object with supported fields');
  }
  if (!isUsageReportPayloadValue(value)) {
    throw new Error('Report payload contains invalid required fields');
  }
  return value;
};

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

export const deserializeUsageRow = (row: SerializedUsageRow): UsageRow => {
  const {
    activeDate: _activeDate,
    freshTokens: _freshTokens,
    lineDelta: _lineDelta,
    projectGroupId: _projectGroupId,
    projectSourceId: _projectSourceId,
    rawProject: _rawProject,
    sessionLabel: _sessionLabel,
    tokenTotal: _tokenTotal,
    ...serializedRow
  } = row;
  return {
    ...serializedRow,
    date: row.date === null ? null : new Date(row.date),
    endDate: row.endDate === null ? null : new Date(row.endDate),
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
