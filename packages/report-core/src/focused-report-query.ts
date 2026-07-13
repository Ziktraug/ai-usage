import { type AnalyticsGroup, type AnalyticsRowInput, groupAnalytics } from './analytics';
import { serializedRowsToCSV } from './csv';
import { type CursorCommitAttributionRow, isCursorCommitAttributionRow } from './datasets';
import { parseProjectGroupConfigs } from './project-group';
import { parseProviderStatusDataset } from './provider-status';
import { MAX_SERVED_BOOTSTRAP_BYTES } from './report-budgets';
import type { SerializedRow, UsageReportPayload } from './report-data';
import { isSerializedUsageRowShape, isStrictIsoTimestamp, isUsageReportWarnings } from './serialized-usage-validation';
import {
  buildSessionCampaignViews,
  buildSortedSessionPresentationRows,
  enrichSessionPresentationRow,
  parseSessionPresentationRow,
  parseSessionQueryRequest,
  type SessionPresentationRow,
  type SessionQueryFilters,
  type SessionQueryRange,
  type SessionQuerySort,
} from './session-query';

export type FocusedReportSupport = Omit<UsageReportPayload, 'rows' | 'tableRows'>;
export type FocusedBootstrapSupport = Pick<
  FocusedReportSupport,
  'analytics' | 'filters' | 'generatedAt' | 'omittedRows' | 'warnings'
> & {
  datasets?: Pick<NonNullable<FocusedReportSupport['datasets']>, 'providerStatus'>;
};

export interface FocusedReportQueryScope {
  filters: SessionQueryFilters;
  range: SessionQueryRange;
  revision: string;
}

export type FocusedTimelineDimension = 'harness' | 'model' | 'project' | 'provider';
export type FocusedTimelineGranularity = 'day' | 'month' | 'week';

export interface FocusedDateDomain {
  first: string;
  last: string;
}

export interface FocusedOverviewRequest {
  includeAdvanced: boolean;
  query: FocusedReportQueryScope;
  timeline: { dimension: FocusedTimelineDimension; granularity: FocusedTimelineGranularity };
}

export interface FocusedBreakdownRequest {
  query: FocusedReportQueryScope;
}

export interface FocusedCsvRequest {
  query: FocusedReportQueryScope;
  sort: SessionQuerySort[];
}

export interface FocusedRevisionRequest {
  revision: string;
}

export interface FocusedReportSummary {
  actualCost: number;
  cacheRead: number;
  cacheWrite: number;
  costQuota: number;
  fresh: number;
  meanCost: number;
  pricedSessions: number;
  rtkInput: number;
  rtkOutput: number;
  rtkSaved: number;
  rtkSessions: number;
  sessionCount: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  totalCost: number;
  turns: number;
  unknownActual: number;
}

export interface FocusedTimelineBucketEntry {
  cost: number;
  sessions: number;
}

export interface FocusedTimelineBucket {
  byKey: Record<string, FocusedTimelineBucketEntry>;
  date: string;
  sessions: number;
  total: number;
}

export interface FocusedTimelineSeries {
  key: string;
  label: string;
  memberKeys?: string[];
  sessions: number;
  total: number;
}

export interface FocusedTimelineData {
  buckets: FocusedTimelineBucket[];
  dimension: FocusedTimelineDimension;
  first: string;
  grandSessions: number;
  grandTotal: number;
  granularity: FocusedTimelineGranularity;
  last: string;
  maxBucketSessions: number;
  maxBucketTotal: number;
  series: FocusedTimelineSeries[];
}

/** A storage-side timeline subtotal for one local calendar day and series key. */
export interface FocusedTimelineAggregate {
  cost: number;
  key: string;
  sessions: number;
  time: number;
}

export interface FocusedOverviewResult {
  dateDomain: FocusedDateDomain | null;
  metadata: Pick<FocusedReportSupport, 'filters' | 'generatedAt' | 'omittedRows'>;
  requestFingerprint: string;
  revision: string;
  summary: FocusedReportSummary;
  timeline: FocusedTimelineData | null;
  view: FocusedOverviewView;
}

export interface FocusedHeatDay {
  cost: number;
  date: string;
  level: number;
  sessions: number;
}

export interface FocusedCalendarHeatmap {
  monthLabels: string[];
  todayKey: string;
  weeks: { days: (FocusedHeatDay | null)[] }[];
}

/** A storage-side subtotal for one local calendar day. */
export interface FocusedDayAggregate {
  cost: number;
  sessions: number;
  time: number;
}

/** A storage-side subtotal for one local weekday/hour cell. */
export interface FocusedPunchcardAggregate {
  cost: number;
  day: number;
  hour: number;
  sessions: number;
}

export interface FocusedOverviewSessionItem {
  costApprox: number;
  durationMs: number | null;
  harness: string;
  kind: 'campaign' | 'session';
  label: string;
  row: SessionPresentationRow;
  sessionCount: number;
}

export interface FocusedSessionShape {
  harnesses: string[];
  harnessSummaries: {
    costMax: number;
    costMin: number;
    durationMax: number;
    durationMin: number;
    groups: number;
    harness: string;
    sessions: number;
  }[];
  outliers: FocusedOverviewSessionItem[];
  points: (FocusedOverviewSessionItem & { aggregateCount: number })[];
  totalPoints: number;
  xDomain: { max: number; min: number };
  xTicks: { label: string; value: number }[];
  yDomain: { max: number; min: number };
  yTicks: { label: string; value: number }[];
}

export interface FocusedOverviewRecords {
  busiest: { cost: number; date: string; sessions: number } | null;
  longest: SessionPresentationRow | null;
  streak: number;
  streakEnd: string | null;
  topCost: SessionPresentationRow | null;
}

export interface FocusedPunchcard {
  cells: { cost: number; sessions: number }[][];
  maxSessions: number;
}

export interface FocusedOverviewView {
  advancedSummary: { hasPunchcard: boolean; hasSessionShape: boolean; summary: string } | null;
  heatmap: FocusedCalendarHeatmap | null;
  previousSummary: FocusedReportSummary | null;
  punchcard: FocusedPunchcard | null;
  records: FocusedOverviewRecords | null;
  sessionShape: FocusedSessionShape | null;
  topSessions: FocusedOverviewSessionItem[];
}

export interface FocusedProjectGroup {
  cache: number;
  cost: number;
  fresh: number;
  key: string;
  linesAdded: number;
  linesDeleted: number;
  priced: number;
  sessions: number;
  tools: number;
  turns: number;
}

export interface FocusedBreakdownResult {
  context: {
    cursorCommitAttribution: CursorCommitAttributionRow[];
    projectGroupConfigs?: NonNullable<FocusedReportSupport['projectGroupConfigs']>;
    projectGroups?: NonNullable<FocusedReportSupport['projectGroups']>;
    warnings?: NonNullable<FocusedReportSupport['warnings']>;
  };
  groups: {
    harnesses: AnalyticsGroup[];
    models: AnalyticsGroup[];
    projects: FocusedProjectGroup[];
    providers: AnalyticsGroup[];
  };
  requestFingerprint: string;
  revision: string;
}

export interface FocusedSupportResult {
  dateDomain: FocusedDateDomain | null;
  filterOptions: { harness: string[]; machine: string[]; truncated: boolean };
  providerRows: SessionPresentationRow[];
  requestFingerprint: string;
  revision: string;
  support: FocusedBootstrapSupport;
  truncation: {
    filterProjectOmitted: number;
    filterSinceOmitted: number;
    harnessOptionsOmitted: number;
    machineOptionsOmitted: number;
    providerRowsOmitted: number;
    providerStatusesOmitted: number;
    warningsOmitted: number;
  };
}

export interface FocusedSupportSourceOmissions {
  harnessOptionsOmitted?: number;
  machineOptionsOmitted?: number;
  providerRowsOmitted?: number;
}

export interface FocusedSupportProjectionOptions {
  dateDomain?: FocusedDateDomain | null;
  providerRows?: SessionPresentationRow[];
  sourceOmissions?: FocusedSupportSourceOmissions;
}

export interface FocusedCsvResult {
  csv: string;
  requestFingerprint: string;
  revision: string;
  rowCount: number;
}

export interface FocusedHtmlPayloadResult {
  payload: UsageReportPayload;
  requestFingerprint: string;
  revision: string;
  rowCount: number;
}

export type FocusedReportQueryKind = 'breakdown' | 'csv' | 'html-payload' | 'overview' | 'support';
export type FocusedReportQueryResult =
  | FocusedBreakdownResult
  | FocusedCsvResult
  | FocusedHtmlPayloadResult
  | FocusedOverviewResult
  | FocusedSupportResult;

const MAX_REVISION_LENGTH = 512;
const MAX_TIMELINE_SERIES = 12;
const OTHER_TIMELINE_SERIES_KEY = '__ai_usage_other__';
const timelineDimensions = new Set<FocusedTimelineDimension>(['harness', 'model', 'project', 'provider']);
const timelineGranularities = new Set<FocusedTimelineGranularity>(['day', 'month', 'week']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};

const parseRevision = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REVISION_LENGTH || value !== value.trim()) {
    throw new Error('revision must be a non-empty trimmed string');
  }
  return value;
};

export const parseFocusedReportQueryScope = (value: unknown): FocusedReportQueryScope => {
  const record = requireRecord(value, 'focused report query');
  assertExactKeys(record, ['filters', 'range', 'revision'], 'focused report query');
  const parsed = parseSessionQueryRequest({
    campaigns: false,
    cursor: null,
    filters: record.filters,
    pageSize: 1,
    range: record.range,
    revision: record.revision,
    sort: [{ desc: true, id: 'date' }],
  });
  return { filters: parsed.filters, range: parsed.range, revision: parsed.revision };
};

export const parseFocusedOverviewRequest = (value: unknown): FocusedOverviewRequest => {
  const record = requireRecord(value, 'overview request');
  assertExactKeys(record, ['includeAdvanced', 'query', 'timeline'], 'overview request');
  if (typeof record.includeAdvanced !== 'boolean') {
    throw new Error('overview request includeAdvanced must be a boolean');
  }
  const timeline = requireRecord(record.timeline, 'timeline');
  assertExactKeys(timeline, ['dimension', 'granularity'], 'timeline');
  if (
    !(
      timelineDimensions.has(timeline.dimension as FocusedTimelineDimension) &&
      timelineGranularities.has(timeline.granularity as FocusedTimelineGranularity)
    )
  ) {
    throw new Error('timeline contains an unsupported dimension or granularity');
  }
  return {
    includeAdvanced: record.includeAdvanced,
    query: parseFocusedReportQueryScope(record.query),
    timeline: {
      dimension: timeline.dimension as FocusedTimelineDimension,
      granularity: timeline.granularity as FocusedTimelineGranularity,
    },
  };
};

export const parseFocusedBreakdownRequest = (value: unknown): FocusedBreakdownRequest => {
  const record = requireRecord(value, 'breakdown request');
  assertExactKeys(record, ['query'], 'breakdown request');
  return { query: parseFocusedReportQueryScope(record.query) };
};

export const parseFocusedCsvRequest = (value: unknown): FocusedCsvRequest => {
  const record = requireRecord(value, 'CSV request');
  assertExactKeys(record, ['query', 'sort'], 'CSV request');
  const query = parseFocusedReportQueryScope(record.query);
  const parsed = parseSessionQueryRequest({
    campaigns: false,
    cursor: null,
    filters: query.filters,
    pageSize: 1,
    range: query.range,
    revision: query.revision,
    sort: record.sort,
  });
  return { query, sort: parsed.sort };
};

export const parseFocusedRevisionRequest = (value: unknown): FocusedRevisionRequest => {
  const record = requireRecord(value, 'focused revision request');
  assertExactKeys(record, ['revision'], 'focused revision request');
  return { revision: parseRevision(record.revision) };
};

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // biome-ignore lint/suspicious/noBitwiseOperators: The XOR step is intrinsic to FNV-1a.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const fingerprint = (kind: FocusedReportQueryKind, scope: unknown): string =>
  `focused-${kind}-v1:${fnv1a64(JSON.stringify(scope))}`;

export const focusedOverviewFingerprint = (input: FocusedOverviewRequest): string => {
  const request = parseFocusedOverviewRequest(input);
  return fingerprint('overview', request);
};

export const focusedAdvancedAnalysisFingerprint = (input: FocusedReportQueryScope): string =>
  `focused-advanced-analysis-v1:${fnv1a64(JSON.stringify(parseFocusedReportQueryScope(input)))}`;

export const focusedBreakdownFingerprint = (input: FocusedBreakdownRequest): string => {
  const request = parseFocusedBreakdownRequest(input);
  return fingerprint('breakdown', request);
};

export const focusedCsvFingerprint = (input: FocusedCsvRequest): string => {
  const request = parseFocusedCsvRequest(input);
  return fingerprint('csv', request);
};

export const focusedRevisionFingerprint = (kind: 'html-payload' | 'support', input: FocusedRevisionRequest): string =>
  fingerprint(kind, parseFocusedRevisionRequest(input));

export const matchesFocusedReportQuery = (row: SessionPresentationRow, query: FocusedReportQueryScope): boolean => {
  const { fields } = query.filters;
  return (
    (!query.filters.query || row.searchText.includes(query.filters.query)) &&
    (query.filters.harness.length === 0 || query.filters.harness.includes(row.harness)) &&
    (query.filters.machine.length === 0 || query.filters.machine.includes(row.source?.machineLabel ?? '')) &&
    (fields.provider === undefined || row.providerDisplay === fields.provider) &&
    (fields.model === undefined || row.modelKey === fields.model) &&
    (fields.project === undefined || row.projectKey === fields.project) &&
    (!query.range.from || (row.activeTime !== null && row.activeTime >= Date.parse(query.range.from))) &&
    (!query.range.to || (row.activeTime !== null && row.activeTime <= Date.parse(query.range.to)))
  );
};

const emptySummary = (): FocusedReportSummary => ({
  actualCost: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costQuota: 0,
  fresh: 0,
  meanCost: 0,
  pricedSessions: 0,
  rtkInput: 0,
  rtkOutput: 0,
  rtkSaved: 0,
  rtkSessions: 0,
  sessionCount: 0,
  tokIn: 0,
  tokOut: 0,
  tools: 0,
  totalCost: 0,
  turns: 0,
  unknownActual: 0,
});

export const buildFocusedReportSummary = (rows: readonly SessionPresentationRow[]): FocusedReportSummary => {
  const summary = emptySummary();
  for (const row of rows) {
    summary.sessionCount++;
    if (row.costKnown) {
      summary.totalCost += row.costApprox;
      summary.pricedSessions++;
    }
    summary.actualCost += row.costActual ?? 0;
    summary.costQuota += row.costQuota ?? 0;
    summary.unknownActual += row.costActual === null ? 1 : 0;
    summary.fresh += row.freshTokens;
    summary.cacheRead += row.tokCr;
    summary.cacheWrite += row.tokCw;
    summary.tokIn += row.tokIn;
    summary.tokOut += row.tokOut;
    summary.rtkSaved += row.rtkSavedTokens ?? 0;
    summary.rtkInput += row.rtkInputTokens ?? 0;
    summary.rtkOutput += row.rtkOutputTokens ?? 0;
    summary.rtkSessions += row.rtkSavedTokens ? 1 : 0;
    summary.turns += row.turns;
    summary.tools += row.tools;
  }
  summary.meanCost = summary.totalCost / (summary.pricedSessions || 1);
  return summary;
};

const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const shiftDays = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const bucketStartFor = (date: Date, granularity: FocusedTimelineGranularity): Date => {
  const day = startOfDay(date);
  if (granularity === 'week') {
    return shiftDays(day, -((day.getDay() + 6) % 7));
  }
  return granularity === 'month' ? new Date(day.getFullYear(), day.getMonth(), 1) : day;
};
const nextBucketStart = (date: Date, granularity: FocusedTimelineGranularity): Date => {
  if (granularity === 'week') {
    return shiftDays(date, 7);
  }
  return granularity === 'month' ? new Date(date.getFullYear(), date.getMonth() + 1, 1) : shiftDays(date, 1);
};
const dateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const timelineKey = (row: SessionPresentationRow, dimension: FocusedTimelineDimension): string => {
  if (dimension === 'harness') {
    return row.harness;
  }
  if (dimension === 'model') {
    return row.modelKey;
  }
  return dimension === 'project' ? row.projectKey : row.providerDisplay;
};

export const buildFocusedTimelineFromAggregates = (
  aggregates: readonly FocusedTimelineAggregate[],
  options: FocusedOverviewRequest['timeline'],
): FocusedTimelineData | null => {
  if (aggregates.length === 0) {
    return null;
  }
  const firstBucket = bucketStartFor(new Date(Math.min(...aggregates.map(({ time }) => time))), options.granularity);
  const lastBucket = bucketStartFor(new Date(Math.max(...aggregates.map(({ time }) => time))), options.granularity);
  const buckets: FocusedTimelineBucket[] = [];
  const bucketByKey = new Map<string, FocusedTimelineBucket>();
  for (let cursor = firstBucket; cursor <= lastBucket; cursor = nextBucketStart(cursor, options.granularity)) {
    const bucket = { byKey: {}, date: cursor.toISOString(), sessions: 0, total: 0 };
    buckets.push(bucket);
    bucketByKey.set(dateKey(cursor), bucket);
  }
  const totals = new Map<string, FocusedTimelineBucketEntry>();
  for (const aggregate of aggregates) {
    const bucket = bucketByKey.get(dateKey(bucketStartFor(new Date(aggregate.time), options.granularity)));
    if (!bucket) {
      continue;
    }
    const { cost, key, sessions } = aggregate;
    const entry = bucket.byKey[key] ?? { cost: 0, sessions: 0 };
    entry.cost += cost;
    entry.sessions += sessions;
    bucket.byKey[key] = entry;
    bucket.total += cost;
    bucket.sessions += sessions;
    const total = totals.get(key) ?? { cost: 0, sessions: 0 };
    total.cost += cost;
    total.sessions += sessions;
    totals.set(key, total);
  }
  const ranked = [...totals.entries()].sort(
    (left, right) => right[1].cost - left[1].cost || right[1].sessions - left[1].sessions,
  );
  let series: FocusedTimelineSeries[] = ranked.map(([key, value]) => ({
    key,
    label: key,
    sessions: value.sessions,
    total: value.cost,
  }));
  if (series.length > MAX_TIMELINE_SERIES) {
    const retained = ranked.slice(0, MAX_TIMELINE_SERIES - 1);
    const aggregated = ranked.slice(MAX_TIMELINE_SERIES - 1);
    let aggregateKey = OTHER_TIMELINE_SERIES_KEY;
    while (totals.has(aggregateKey)) {
      aggregateKey = `_${aggregateKey}`;
    }
    const memberKeys = aggregated.map(([key]) => key);
    for (const bucket of buckets) {
      const aggregate = { cost: 0, sessions: 0 };
      for (const key of memberKeys) {
        const entry = bucket.byKey[key];
        if (entry) {
          aggregate.cost += entry.cost;
          aggregate.sessions += entry.sessions;
          delete bucket.byKey[key];
        }
      }
      if (aggregate.sessions > 0) {
        bucket.byKey[aggregateKey] = aggregate;
      }
    }
    const aggregate = aggregated.reduce(
      (total, [, value]) => ({ cost: total.cost + value.cost, sessions: total.sessions + value.sessions }),
      { cost: 0, sessions: 0 },
    );
    series = [
      ...retained.map(([key, value]) => ({ key, label: key, sessions: value.sessions, total: value.cost })),
      { key: aggregateKey, label: 'Other', memberKeys, sessions: aggregate.sessions, total: aggregate.cost },
    ];
  }
  return {
    buckets,
    dimension: options.dimension,
    first: buckets[0]?.date ?? firstBucket.toISOString(),
    grandSessions: ranked.reduce((sum, [, value]) => sum + value.sessions, 0),
    grandTotal: ranked.reduce((sum, [, value]) => sum + value.cost, 0),
    granularity: options.granularity,
    last: buckets.at(-1)?.date ?? lastBucket.toISOString(),
    maxBucketSessions: buckets.reduce((max, bucket) => Math.max(max, bucket.sessions), 0),
    maxBucketTotal: buckets.reduce((max, bucket) => Math.max(max, bucket.total), 0),
    series,
  };
};

export const buildFocusedDateDomain = (times: Iterable<number>): FocusedDateDomain | null => {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (!Number.isFinite(time)) {
      continue;
    }
    first = Math.min(first, time);
    last = Math.max(last, time);
  }
  return Number.isFinite(first) ? { first: new Date(first).toISOString(), last: new Date(last).toISOString() } : null;
};

export const buildFocusedTimeline = (
  rows: readonly SessionPresentationRow[],
  options: FocusedOverviewRequest['timeline'],
): FocusedTimelineData | null =>
  buildFocusedTimelineFromAggregates(
    rows.flatMap((row) =>
      row.activeTime === null
        ? []
        : [
            {
              cost: row.costKnown ? row.costApprox : 0,
              key: timelineKey(row, options.dimension),
              sessions: 1,
              time: row.activeTime,
            },
          ],
    ),
    options,
  );

const analyticsInput = (row: SessionPresentationRow): AnalyticsRowInput => ({
  ambiguous: row.ambiguous ?? false,
  cache: row.tokCr,
  fresh: row.freshTokens,
  harness: row.harness,
  inp: row.tokIn,
  linesAdded: row.linesAdded ?? 0,
  linesDeleted: row.linesDeleted ?? 0,
  pricedCost: row.costKnown ? row.costApprox : null,
  provider: row.provider,
  tools: row.tools,
  turns: row.turns,
  usageUnavailable: row.usageUnavailable ?? false,
});

const projectGroups = (rows: readonly SessionPresentationRow[]): FocusedProjectGroup[] => {
  const groups = new Map<string, FocusedProjectGroup>();
  for (const row of rows) {
    const group = groups.get(row.projectKey) ?? {
      cache: 0,
      cost: 0,
      fresh: 0,
      key: row.projectKey,
      linesAdded: 0,
      linesDeleted: 0,
      priced: 0,
      sessions: 0,
      tools: 0,
      turns: 0,
    };
    group.sessions++;
    group.fresh += row.freshTokens;
    group.cache += row.tokCr;
    group.turns += row.turns;
    group.tools += row.tools;
    group.linesAdded += row.linesAdded ?? 0;
    group.linesDeleted += row.linesDeleted ?? 0;
    if (row.costKnown) {
      group.cost += row.costApprox;
      group.priced++;
    }
    groups.set(row.projectKey, group);
  }
  return [...groups.values()].sort((left, right) => right.cost - left.cost || right.fresh - left.fresh);
};

export const buildFocusedHeatmapFromAggregates = (
  aggregates: readonly FocusedDayAggregate[],
  now = new Date(),
): FocusedCalendarHeatmap | null => {
  const byDay = new Map<string, { cost: number; sessions: number }>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const aggregate of aggregates) {
    minTime = Math.min(minTime, aggregate.time);
    maxTime = Math.max(maxTime, aggregate.time);
    const key = dateKey(startOfDay(new Date(aggregate.time)));
    const entry = byDay.get(key) ?? { cost: 0, sessions: 0 };
    entry.cost += aggregate.cost;
    entry.sessions += aggregate.sessions;
    byDay.set(key, entry);
  }
  if (byDay.size === 0) {
    return null;
  }
  const last = startOfDay(new Date(maxTime));
  let first = startOfDay(new Date(minTime));
  if ((last.getTime() - first.getTime()) / 86_400_000 > 730) {
    first = shiftDays(last, -730);
  }
  const gridStart = shiftDays(first, -((first.getDay() + 6) % 7));
  const sorted = [...byDay.values()].map(({ sessions }) => sessions).sort((left, right) => left - right);
  const quantile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const weeks: FocusedCalendarHeatmap['weeks'] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  for (let cursor = gridStart; cursor <= last; cursor = shiftDays(cursor, 7)) {
    const days: (FocusedHeatDay | null)[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = shiftDays(cursor, offset);
      if (date < first || date > last) {
        days.push(null);
        continue;
      }
      const entry = byDay.get(dateKey(date));
      const sessions = entry?.sessions ?? 0;
      days.push({
        cost: entry?.cost ?? 0,
        date: date.toISOString(),
        level: sessions <= 0 ? 0 : 1 + thresholds.filter((threshold) => sessions > threshold).length,
        sessions,
      });
    }
    weeks.push({ days });
    const month = cursor.getMonth();
    monthLabels.push(month === previousMonth ? '' : cursor.toLocaleDateString('en', { month: 'short' }));
    previousMonth = month;
  }
  return { monthLabels, todayKey: dateKey(startOfDay(now)), weeks };
};

const buildHeatmap = (rows: readonly SessionPresentationRow[], now = new Date()): FocusedCalendarHeatmap | null =>
  buildFocusedHeatmapFromAggregates(
    rows.flatMap((row) =>
      row.activeTime === null
        ? []
        : [
            {
              cost: row.costKnown ? row.costApprox : 0,
              sessions: 1,
              time: row.activeTime,
            },
          ],
    ),
    now,
  );

const overviewSessionItems = (
  rows: readonly SessionPresentationRow[],
  campaigns: ReturnType<typeof buildSessionCampaignViews>,
): FocusedOverviewSessionItem[] => {
  const campaignRows = new Set(campaigns.flatMap((campaign) => campaign.visibleRows.map((row) => row.rowId)));
  return [
    ...campaigns.map(
      (campaign): FocusedOverviewSessionItem => ({
        costApprox: campaign.visibleTotals.totalCost,
        durationMs: campaign.visibleTotals.durationMs,
        harness: campaign.root.harness,
        kind: 'campaign',
        label: campaign.root.sessionLabel,
        row: campaign.root,
        sessionCount: campaign.visibleCount,
      }),
    ),
    ...rows
      .filter((row) => !campaignRows.has(row.rowId))
      .map(
        (row): FocusedOverviewSessionItem => ({
          costApprox: row.costApprox,
          durationMs: row.durationMs,
          harness: row.harness,
          kind: 'session',
          label: row.sessionLabel,
          row,
          sessionCount: 1,
        }),
      ),
  ];
};

const DURATION_TICKS = [
  { label: '1m', value: 60_000 },
  { label: '10m', value: 600_000 },
  { label: '1h', value: 3_600_000 },
  { label: '4h', value: 14_400_000 },
];
const COST_TICKS = [
  { label: '$0.01', value: 0.01 },
  { label: '$0.10', value: 0.1 },
  { label: '$1', value: 1 },
  { label: '$10', value: 10 },
  { label: '$100', value: 100 },
];

const buildSessionShape = (items: FocusedOverviewSessionItem[]): FocusedSessionShape | null => {
  const timed = items.filter(
    (item): item is FocusedOverviewSessionItem & { durationMs: number } =>
      item.durationMs !== null && item.durationMs > 0 && item.costApprox > 0,
  );
  if (timed.length < 3) {
    return null;
  }
  const xMin = Math.min(...timed.map((item) => item.durationMs));
  const xMax = Math.max(...timed.map((item) => item.durationMs));
  const yMin = Math.min(...timed.map((item) => item.costApprox));
  const yMax = Math.max(...timed.map((item) => item.costApprox));
  const xLo = Math.log10(xMin) - 0.08;
  const xHi = Math.log10(xMax) + 0.08;
  const yLo = Math.log10(yMin) - 0.12;
  const yHi = Math.log10(yMax) + 0.12;
  const normalizedX = (item: FocusedOverviewSessionItem & { durationMs: number }): number =>
    (Math.log10(item.durationMs) - xLo) / Math.max(1e-9, xHi - xLo);
  const normalizedY = (item: FocusedOverviewSessionItem & { durationMs: number }): number =>
    (Math.log10(item.costApprox) - yLo) / Math.max(1e-9, yHi - yLo);
  const score = (item: FocusedOverviewSessionItem & { durationMs: number }): number =>
    normalizedX(item) + normalizedY(item);
  const harnesses = [...new Set(timed.map((item) => item.harness))];
  const binsPerHarness = Math.max(1, Math.floor(240 / Math.max(1, harnesses.length)));
  const columns = Math.max(1, Math.floor(Math.sqrt(binsPerHarness * 1.6)));
  const rows = Math.max(1, Math.floor(binsPerHarness / columns));
  const bins = new Map<string, { count: number; representative: (typeof timed)[number] }>();
  for (const item of timed) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor(normalizedX(item) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(normalizedY(item) * rows)));
    const key = `${item.harness}:${column}:${row}`;
    const bin = bins.get(key);
    if (bin) {
      bin.count += item.sessionCount;
      if (score(item) > score(bin.representative)) {
        bin.representative = item;
      }
    } else {
      bins.set(key, { count: item.sessionCount, representative: item });
    }
  }
  const rankings = [
    [...timed].sort((left, right) => right.costApprox - left.costApprox || right.durationMs - left.durationMs),
    [...timed].sort((left, right) => right.durationMs - left.durationMs || right.costApprox - left.costApprox),
    [...timed].sort((left, right) => score(right) - score(left) || right.costApprox - left.costApprox),
  ];
  const outliers: (typeof timed)[number][] = [];
  const selected = new Set<string>();
  for (let rank = 0; outliers.length < 6 && rank < timed.length; rank++) {
    for (const ranking of rankings) {
      const item = ranking[rank];
      if (item && !selected.has(item.row.rowId)) {
        selected.add(item.row.rowId);
        outliers.push(item);
        if (outliers.length === 6) {
          break;
        }
      }
    }
  }
  const harnessSummaries = harnesses
    .map((harness) => {
      const itemsForHarness = timed.filter((item) => item.harness === harness);
      return {
        costMax: Math.max(...itemsForHarness.map((item) => item.costApprox)),
        costMin: Math.min(...itemsForHarness.map((item) => item.costApprox)),
        durationMax: Math.max(...itemsForHarness.map((item) => item.durationMs)),
        durationMin: Math.min(...itemsForHarness.map((item) => item.durationMs)),
        groups: itemsForHarness.length,
        harness,
        sessions: itemsForHarness.reduce((sum, item) => sum + item.sessionCount, 0),
      };
    })
    .sort((left, right) => right.sessions - left.sessions || left.harness.localeCompare(right.harness));
  return {
    harnessSummaries,
    harnesses,
    outliers,
    points: [...bins.values()].map(({ count, representative }) => ({ ...representative, aggregateCount: count })),
    totalPoints: timed.reduce((sum, item) => sum + item.sessionCount, 0),
    xDomain: { max: xHi, min: xLo },
    xTicks: DURATION_TICKS.filter((tick) => tick.value >= xMin && tick.value <= xMax),
    yDomain: { max: yHi, min: yLo },
    yTicks: COST_TICKS.filter((tick) => tick.value >= yMin && tick.value <= yMax),
  };
};

export const buildFocusedPunchcardFromAggregates = (
  aggregates: readonly FocusedPunchcardAggregate[],
): FocusedPunchcard | null => {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, sessions: 0 })));
  let maxSessions = 0;
  for (const aggregate of aggregates) {
    const cell = cells[aggregate.day]?.[aggregate.hour];
    if (cell) {
      cell.sessions += aggregate.sessions;
      cell.cost += aggregate.cost;
      maxSessions = Math.max(maxSessions, cell.sessions);
    }
  }
  return maxSessions > 0 ? { cells, maxSessions } : null;
};

const buildPunchcard = (rows: readonly SessionPresentationRow[]): FocusedPunchcard | null =>
  buildFocusedPunchcardFromAggregates(
    rows.flatMap((row) => {
      if (row.activeTime === null) {
        return [];
      }
      const date = new Date(row.activeTime);
      return [
        {
          cost: row.costKnown ? row.costApprox : 0,
          day: (date.getDay() + 6) % 7,
          hour: date.getHours(),
          sessions: 1,
        },
      ];
    }),
  );

export const buildFocusedRecordsFromAggregates = (
  topCost: SessionPresentationRow | null,
  longest: SessionPresentationRow | null,
  visibleDays: readonly FocusedDayAggregate[],
  timelineDays: readonly FocusedDayAggregate[],
): FocusedOverviewRecords | null => {
  const days = visibleDays.map(({ cost, sessions, time }) => ({
    cost,
    date: startOfDay(new Date(time)).toISOString(),
    sessions,
  }));
  const busiest = days.reduce<(typeof days)[number] | null>(
    (best, entry) =>
      best === null || entry.cost > best.cost || (entry.cost === best.cost && entry.sessions > best.sessions)
        ? entry
        : best,
    null,
  );
  const streakDays = new Set<string>();
  let lastDay: Date | null = null;
  for (const { time } of timelineDays) {
    const day = startOfDay(new Date(time));
    streakDays.add(dateKey(day));
    if (lastDay === null || day.getTime() > lastDay.getTime()) {
      lastDay = day;
    }
  }
  let streak = 0;
  if (lastDay) {
    for (let cursor = lastDay; streakDays.has(dateKey(cursor)); cursor = shiftDays(cursor, -1)) {
      streak++;
    }
  }
  return topCost || longest || busiest || streak > 0
    ? { busiest, longest, streak, streakEnd: lastDay?.toISOString() ?? null, topCost }
    : null;
};

const dayAggregatesForRows = (rows: readonly SessionPresentationRow[]): FocusedDayAggregate[] => {
  const byDay = new Map<string, FocusedDayAggregate>();
  for (const row of rows) {
    if (row.activeTime === null) {
      continue;
    }
    const day = startOfDay(new Date(row.activeTime));
    const key = dateKey(day);
    const aggregate = byDay.get(key) ?? { cost: 0, sessions: 0, time: day.getTime() };
    aggregate.cost += row.costKnown ? row.costApprox : 0;
    aggregate.sessions += 1;
    byDay.set(key, aggregate);
  }
  return [...byDay.values()];
};

const buildRecords = (
  rows: readonly SessionPresentationRow[],
  timelineRows: readonly SessionPresentationRow[],
): FocusedOverviewRecords | null => {
  const topCost = rows.reduce<SessionPresentationRow | null>(
    (best, row) =>
      row.costKnown && row.costApprox > 0 && (best === null || row.costApprox > best.costApprox) ? row : best,
    null,
  );
  const longest = rows.reduce<SessionPresentationRow | null>(
    (best, row) =>
      (row.durationMs ?? 0) > 0 && (best === null || (row.durationMs ?? 0) > (best.durationMs ?? 0)) ? row : best,
    null,
  );
  return buildFocusedRecordsFromAggregates(
    topCost,
    longest,
    dayAggregatesForRows(rows),
    dayAggregatesForRows(timelineRows),
  );
};

const previousPeriodSummary = (
  timelineRows: readonly SessionPresentationRow[],
  query: FocusedReportQueryScope,
  generatedAt: string,
): FocusedReportSummary | null => {
  if (!query.range.from) {
    return null;
  }
  const from = Date.parse(query.range.from);
  const to = query.range.to ? Date.parse(query.range.to) : Date.parse(generatedAt);
  const span = Math.max(86_400_000, to - from);
  const rows = timelineRows.filter(
    (row) => row.activeTime !== null && row.activeTime >= from - span && row.activeTime <= from - 1,
  );
  return rows.length > 0 ? buildFocusedReportSummary(rows) : null;
};

export const projectFocusedOverviewFromPresentationRows = (
  allRows: SessionPresentationRow[],
  support: FocusedReportSupport,
  input: FocusedOverviewRequest,
): FocusedOverviewResult => {
  const request = parseFocusedOverviewRequest(input);
  const timelineQuery = { ...request.query, range: { from: null, to: null } };
  const timelineRows = allRows.filter((row) => matchesFocusedReportQuery(row, timelineQuery));
  const visible = timelineRows.filter((row) => matchesFocusedReportQuery(row, request.query));
  const campaigns = buildSessionCampaignViews(allRows, visible);
  const sessionItems = overviewSessionItems(visible, campaigns);
  const sessionShape = request.includeAdvanced ? buildSessionShape(sessionItems) : null;
  const punchcard = request.includeAdvanced ? buildPunchcard(visible) : null;
  const availableAnalyses = [
    ...(sessionShape ? ['Duration/value patterns'] : []),
    ...(punchcard ? ['weekly/hourly activity'] : []),
  ];
  return {
    dateDomain: buildFocusedDateDomain(
      timelineRows.flatMap((row) => (row.activeTime === null ? [] : [row.activeTime])),
    ),
    metadata: { filters: support.filters, generatedAt: support.generatedAt, omittedRows: support.omittedRows },
    requestFingerprint: focusedOverviewFingerprint(request),
    revision: request.query.revision,
    summary: buildFocusedReportSummary(visible),
    timeline: buildFocusedTimeline(timelineRows, request.timeline),
    view: {
      advancedSummary:
        availableAnalyses.length === 0
          ? null
          : {
              hasPunchcard: punchcard !== null,
              hasSessionShape: sessionShape !== null,
              summary: `${availableAnalyses.join(' and ')} · ${visible.length} ${visible.length === 1 ? 'session' : 'sessions'}`,
            },
      heatmap: buildHeatmap(timelineRows),
      previousSummary: previousPeriodSummary(timelineRows, request.query, support.generatedAt),
      punchcard,
      records: buildRecords(visible, timelineRows),
      sessionShape,
      topSessions: sessionItems
        .filter((item) => item.costApprox > 0)
        .sort((left, right) => right.costApprox - left.costApprox)
        .slice(0, 5),
    },
  };
};

export const projectFocusedOverview = (
  rows: SerializedRow[],
  support: FocusedReportSupport,
  input: FocusedOverviewRequest,
): FocusedOverviewResult =>
  projectFocusedOverviewFromPresentationRows(rows.map(enrichSessionPresentationRow), support, input);

export const projectFocusedBreakdown = (
  rows: SerializedRow[],
  support: FocusedReportSupport,
  input: FocusedBreakdownRequest,
): FocusedBreakdownResult => {
  const request = parseFocusedBreakdownRequest(input);
  const visible = rows.map(enrichSessionPresentationRow).filter((row) => matchesFocusedReportQuery(row, request.query));
  const totalCost = visible.reduce((sum, row) => sum + (row.costKnown ? row.costApprox : 0), 0);
  return {
    context: {
      cursorCommitAttribution: support.datasets?.cursorCommitAttribution ?? [],
      ...(support.projectGroupConfigs === undefined ? {} : { projectGroupConfigs: support.projectGroupConfigs }),
      ...(support.projectGroups === undefined ? {} : { projectGroups: support.projectGroups }),
      ...(support.warnings === undefined ? {} : { warnings: support.warnings }),
    },
    groups: {
      harnesses: groupAnalytics(visible, analyticsInput, (row) => row.harness, totalCost),
      models: groupAnalytics(visible, analyticsInput, (row) => row.modelKey, totalCost),
      projects: projectGroups(visible),
      providers: groupAnalytics(visible, analyticsInput, (row) => row.providerDisplay, totalCost),
    },
    requestFingerprint: focusedBreakdownFingerprint(request),
    revision: request.query.revision,
  };
};

export const projectFocusedCsv = (rows: SerializedRow[], input: FocusedCsvRequest): FocusedCsvResult => {
  const request = parseFocusedCsvRequest(input);
  const visible = buildSortedSessionPresentationRows(
    rows.map(enrichSessionPresentationRow).filter((row) => matchesFocusedReportQuery(row, request.query)),
    request.sort,
  );
  return {
    csv: serializedRowsToCSV(visible),
    requestFingerprint: focusedCsvFingerprint(request),
    revision: request.query.revision,
    rowCount: visible.length,
  };
};

export const projectFocusedHtmlPayload = (
  rows: SerializedRow[],
  support: FocusedReportSupport,
  input: FocusedRevisionRequest,
): FocusedHtmlPayloadResult => {
  const request = parseFocusedRevisionRequest(input);
  return {
    payload: {
      ...support,
      rows,
      tableRows: support.filters.limit ? rows.slice(0, support.filters.limit) : rows,
    },
    requestFingerprint: focusedRevisionFingerprint('html-payload', request),
    revision: request.revision,
    rowCount: rows.length,
  };
};

export const projectFocusedSupport = (
  support: FocusedReportSupport,
  filterOptions: FocusedSupportResult['filterOptions'],
  input: FocusedRevisionRequest,
  options: FocusedSupportProjectionOptions = {},
): FocusedSupportResult => {
  const request = parseFocusedRevisionRequest(input);
  const { dateDomain = null, providerRows = [], sourceOmissions = {} } = options;
  const providerStatus =
    parseProviderStatusDataset(support.datasets?.providerStatus) ??
    parseProviderStatusDataset(support.facets?.providerStatus);
  const maximumSupportItems = 100;
  const textEncoder = new TextEncoder();
  const fitsTextBudget = (value: string | null, maximumBytes: number): boolean =>
    value === null || textEncoder.encode(value).byteLength <= maximumBytes;
  const project = fitsTextBudget(support.filters.project, 4096) ? support.filters.project : null;
  const since = fitsTextBudget(support.filters.since, 256) ? support.filters.since : null;
  const acceptedHarnesses: string[] = [];
  const acceptedMachines: string[] = [];
  const acceptedProviderRows: SessionPresentationRow[] = [];
  const acceptedProviderStatuses: NonNullable<typeof providerStatus>['providers'] = [];
  const acceptedWarnings: NonNullable<FocusedReportSupport['warnings']> = [];
  const truncation: FocusedSupportResult['truncation'] = {
    filterProjectOmitted: project === support.filters.project ? 0 : 1,
    filterSinceOmitted: since === support.filters.since ? 0 : 1,
    harnessOptionsOmitted:
      (sourceOmissions.harnessOptionsOmitted ?? 0) + Math.max(0, filterOptions.harness.length - maximumSupportItems),
    machineOptionsOmitted:
      (sourceOmissions.machineOptionsOmitted ?? 0) + Math.max(0, filterOptions.machine.length - maximumSupportItems),
    providerRowsOmitted:
      (sourceOmissions.providerRowsOmitted ?? 0) + Math.max(0, providerRows.length - maximumSupportItems),
    providerStatusesOmitted: providerStatus?.providers.length ?? 0,
    warningsOmitted: support.warnings?.length ?? 0,
  };

  const createResult = (): FocusedSupportResult => ({
    dateDomain,
    filterOptions: {
      harness: acceptedHarnesses,
      machine: acceptedMachines,
      truncated:
        filterOptions.truncated ||
        truncation.harnessOptionsOmitted > 0 ||
        truncation.machineOptionsOmitted > 0 ||
        truncation.providerRowsOmitted > 0,
    },
    providerRows: acceptedProviderRows,
    requestFingerprint: focusedRevisionFingerprint('support', request),
    revision: request.revision,
    support: {
      analytics: {
        ...support.analytics,
        byHarness: [],
        byModel: [],
        byProvider: [],
      },
      filters: { ...support.filters, project, since },
      generatedAt: support.generatedAt,
      omittedRows: support.omittedRows,
      ...(providerStatus === null
        ? {}
        : { datasets: { providerStatus: { ...providerStatus, providers: acceptedProviderStatuses } } }),
      ...(support.warnings === undefined ? {} : { warnings: acceptedWarnings }),
    },
    truncation,
  });
  const resultFitsBudget = (): boolean =>
    textEncoder.encode(JSON.stringify(createResult())).byteLength <= MAX_SERVED_BOOTSTRAP_BYTES;

  for (const harness of filterOptions.harness.slice(0, maximumSupportItems)) {
    acceptedHarnesses.push(harness);
    if (!resultFitsBudget()) {
      acceptedHarnesses.pop();
      truncation.harnessOptionsOmitted += 1;
    }
  }
  for (const machine of filterOptions.machine.slice(0, maximumSupportItems)) {
    acceptedMachines.push(machine);
    if (!resultFitsBudget()) {
      acceptedMachines.pop();
      truncation.machineOptionsOmitted += 1;
    }
  }
  for (const providerRow of providerRows.slice(0, maximumSupportItems)) {
    acceptedProviderRows.push(providerRow);
    if (!resultFitsBudget()) {
      acceptedProviderRows.pop();
      truncation.providerRowsOmitted += 1;
    }
  }
  for (const status of providerStatus?.providers.slice(0, maximumSupportItems) ?? []) {
    acceptedProviderStatuses.push(status);
    truncation.providerStatusesOmitted -= 1;
    if (!resultFitsBudget()) {
      acceptedProviderStatuses.pop();
      truncation.providerStatusesOmitted += 1;
    }
  }
  for (const warning of support.warnings?.slice(0, maximumSupportItems) ?? []) {
    acceptedWarnings.push(warning);
    truncation.warningsOmitted -= 1;
    if (!resultFitsBudget()) {
      acceptedWarnings.pop();
      truncation.warningsOmitted += 1;
    }
  }
  const result = createResult();
  if (textEncoder.encode(JSON.stringify(result)).byteLength > MAX_SERVED_BOOTSTRAP_BYTES) {
    throw new Error('The fixed focused bootstrap fields exceed the served bootstrap byte budget');
  }
  return result;
};

const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const assertResultEnvelope = (
  value: unknown,
  keys: readonly string[],
  revision: string,
  requestFingerprint: string,
): Record<string, unknown> => {
  const record = requireRecord(value, 'focused report result');
  assertExactKeys(record, keys, 'focused report result');
  if (record.revision !== revision || record.requestFingerprint !== requestFingerprint || !isJsonValue(record)) {
    throw new Error('Focused report result has an invalid revision, fingerprint, or JSON value');
  }
  return record;
};

const assertAllowedKeys = (
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): void => {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};

const requireFiniteNumber = (
  value: unknown,
  label: string,
  { maximum = Number.POSITIVE_INFINITY, minimum = 0 }: { maximum?: number; minimum?: number } = {},
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
};

const requireNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
};

const requirePositiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  if (!isStrictIsoTimestamp(value)) {
    throw new Error(`${label} must be a strict ISO timestamp`);
  }
  return value;
};

const assertStringArray: (value: unknown, label: string, maximumLength?: number) => asserts value is string[] = (
  value,
  label,
  maximumLength,
) => {
  if (
    !Array.isArray(value) ||
    (maximumLength !== undefined && value.length > maximumLength) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${label} must be a bounded string array`);
  }
};

const assertReportFilters = (value: unknown, label: string): void => {
  const filters = requireRecord(value, label);
  assertExactKeys(filters, ['limit', 'minTokens', 'project', 'since', 'sort'], label);
  if (filters.limit !== null) {
    requireNonNegativeSafeInteger(filters.limit, `${label}.limit`);
  }
  requireNonNegativeSafeInteger(filters.minTokens, `${label}.minTokens`);
  if (filters.project !== null) {
    requireString(filters.project, `${label}.project`);
  }
  if (filters.since !== null) {
    requireIsoTimestamp(filters.since, `${label}.since`);
  }
  if (!(filters.sort === 'cost' || filters.sort === 'date' || filters.sort === 'tokens')) {
    throw new Error(`${label}.sort is invalid`);
  }
};

const FOCUSED_REPORT_SUMMARY_KEYS = [
  'actualCost',
  'cacheRead',
  'cacheWrite',
  'costQuota',
  'fresh',
  'meanCost',
  'pricedSessions',
  'rtkInput',
  'rtkOutput',
  'rtkSaved',
  'rtkSessions',
  'sessionCount',
  'tokIn',
  'tokOut',
  'tools',
  'totalCost',
  'turns',
  'unknownActual',
] as const;

const assertFocusedSummary = (value: unknown, label: string): void => {
  const summary = requireRecord(value, label);
  assertExactKeys(summary, FOCUSED_REPORT_SUMMARY_KEYS, label);
  for (const key of FOCUSED_REPORT_SUMMARY_KEYS) {
    requireFiniteNumber(summary[key], `${label}.${key}`);
  }
  for (const key of ['pricedSessions', 'rtkSessions', 'sessionCount', 'unknownActual'] as const) {
    requireNonNegativeSafeInteger(summary[key], `${label}.${key}`);
  }
};

const assertTimelineSeries = (value: unknown): Set<string> => {
  if (!Array.isArray(value) || value.length > MAX_TIMELINE_SERIES) {
    throw new Error('overview timeline.series exceeds its presentation bound');
  }
  const keys = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const series = requireRecord(entry, `overview timeline.series[${index}]`);
    assertAllowedKeys(series, ['key', 'label', 'sessions', 'total'], ['memberKeys'], 'overview timeline series');
    const key = requireString(series.key, 'overview timeline series.key');
    requireString(series.label, 'overview timeline series.label');
    requireNonNegativeSafeInteger(series.sessions, 'overview timeline series.sessions');
    requireFiniteNumber(series.total, 'overview timeline series.total');
    if (series.memberKeys !== undefined) {
      assertStringArray(series.memberKeys, 'overview timeline series.memberKeys');
    }
    if (keys.has(key)) {
      throw new Error('overview timeline series keys must be unique');
    }
    keys.add(key);
  }
  return keys;
};

const assertTimelineBuckets = (value: unknown, seriesKeys: ReadonlySet<string>): void => {
  if (!Array.isArray(value)) {
    throw new Error('overview timeline.buckets must be an array');
  }
  for (const [index, entry] of value.entries()) {
    const bucket = requireRecord(entry, `overview timeline.buckets[${index}]`);
    assertExactKeys(bucket, ['byKey', 'date', 'sessions', 'total'], 'overview timeline bucket');
    requireIsoTimestamp(bucket.date, 'overview timeline bucket.date');
    requireNonNegativeSafeInteger(bucket.sessions, 'overview timeline bucket.sessions');
    requireFiniteNumber(bucket.total, 'overview timeline bucket.total');
    const byKey = requireRecord(bucket.byKey, 'overview timeline bucket.byKey');
    if (Object.keys(byKey).length > MAX_TIMELINE_SERIES) {
      throw new Error('overview timeline bucket.byKey exceeds its presentation bound');
    }
    for (const [key, rawTotals] of Object.entries(byKey)) {
      if (!seriesKeys.has(key)) {
        throw new Error('overview timeline bucket contains an unknown series key');
      }
      const totals = requireRecord(rawTotals, `overview timeline bucket.byKey.${key}`);
      assertExactKeys(totals, ['cost', 'sessions'], 'overview timeline bucket entry');
      requireFiniteNumber(totals.cost, 'overview timeline bucket entry.cost');
      requireNonNegativeSafeInteger(totals.sessions, 'overview timeline bucket entry.sessions');
    }
  }
};

const assertFocusedTimeline = (value: unknown, expected: FocusedOverviewRequest['timeline']): void => {
  if (value === null) {
    return;
  }
  const timeline = requireRecord(value, 'overview timeline');
  assertExactKeys(
    timeline,
    [
      'buckets',
      'dimension',
      'first',
      'grandSessions',
      'grandTotal',
      'granularity',
      'last',
      'maxBucketSessions',
      'maxBucketTotal',
      'series',
    ],
    'overview timeline',
  );
  if (timeline.dimension !== expected.dimension || timeline.granularity !== expected.granularity) {
    throw new Error('overview timeline does not match the requested dimension and granularity');
  }
  requireIsoTimestamp(timeline.first, 'overview timeline.first');
  requireIsoTimestamp(timeline.last, 'overview timeline.last');
  requireNonNegativeSafeInteger(timeline.grandSessions, 'overview timeline.grandSessions');
  requireFiniteNumber(timeline.grandTotal, 'overview timeline.grandTotal');
  requireNonNegativeSafeInteger(timeline.maxBucketSessions, 'overview timeline.maxBucketSessions');
  requireFiniteNumber(timeline.maxBucketTotal, 'overview timeline.maxBucketTotal');
  assertTimelineBuckets(timeline.buckets, assertTimelineSeries(timeline.series));
};

const assertOverviewSessionItem = (value: unknown, label: string, requireAggregateCount = false): void => {
  const item = requireRecord(value, label);
  const requiredKeys = ['costApprox', 'durationMs', 'harness', 'kind', 'label', 'row', 'sessionCount'];
  assertExactKeys(item, requireAggregateCount ? [...requiredKeys, 'aggregateCount'] : requiredKeys, label);
  requireFiniteNumber(item.costApprox, `${label}.costApprox`);
  if (item.durationMs !== null) {
    requireFiniteNumber(item.durationMs, `${label}.durationMs`);
  }
  requireString(item.harness, `${label}.harness`);
  requireString(item.label, `${label}.label`);
  if (!(item.kind === 'campaign' || item.kind === 'session')) {
    throw new Error(`${label}.kind is invalid`);
  }
  parseSessionPresentationRow(item.row, `${label}.row`);
  requirePositiveSafeInteger(item.sessionCount, `${label}.sessionCount`);
  if (requireAggregateCount) {
    requirePositiveSafeInteger(item.aggregateCount, `${label}.aggregateCount`);
  }
};

const assertHeatmap = (value: unknown): void => {
  if (value === null) {
    return;
  }
  const heatmap = requireRecord(value, 'overview heatmap');
  assertExactKeys(heatmap, ['monthLabels', 'todayKey', 'weeks'], 'overview heatmap');
  assertStringArray(heatmap.monthLabels, 'overview heatmap.monthLabels', 106);
  requireString(heatmap.todayKey, 'overview heatmap.todayKey');
  if (
    !Array.isArray(heatmap.weeks) ||
    heatmap.weeks.length > 106 ||
    heatmap.monthLabels.length !== heatmap.weeks.length
  ) {
    throw new Error('overview heatmap weeks exceed their presentation bound');
  }
  for (const [weekIndex, valueWeek] of heatmap.weeks.entries()) {
    const week = requireRecord(valueWeek, `overview heatmap.weeks[${weekIndex}]`);
    assertExactKeys(week, ['days'], 'overview heatmap week');
    if (!Array.isArray(week.days) || week.days.length !== 7) {
      throw new Error('overview heatmap week must contain seven days');
    }
    for (const [dayIndex, valueDay] of week.days.entries()) {
      if (valueDay === null) {
        continue;
      }
      const day = requireRecord(valueDay, `overview heatmap.weeks[${weekIndex}].days[${dayIndex}]`);
      assertExactKeys(day, ['cost', 'date', 'level', 'sessions'], 'overview heatmap day');
      requireFiniteNumber(day.cost, 'overview heatmap day.cost');
      requireIsoTimestamp(day.date, 'overview heatmap day.date');
      requireFiniteNumber(day.level, 'overview heatmap day.level', { maximum: 4 });
      requireNonNegativeSafeInteger(day.level, 'overview heatmap day.level');
      requireNonNegativeSafeInteger(day.sessions, 'overview heatmap day.sessions');
    }
  }
};

const assertPunchcard = (value: unknown): void => {
  if (value === null) {
    return;
  }
  const punchcard = requireRecord(value, 'overview punchcard');
  assertExactKeys(punchcard, ['cells', 'maxSessions'], 'overview punchcard');
  requireNonNegativeSafeInteger(punchcard.maxSessions, 'overview punchcard.maxSessions');
  if (!Array.isArray(punchcard.cells) || punchcard.cells.length !== 7) {
    throw new Error('overview punchcard must contain seven days');
  }
  for (const day of punchcard.cells) {
    if (!Array.isArray(day) || day.length !== 24) {
      throw new Error('overview punchcard days must contain 24 hours');
    }
    for (const valueCell of day) {
      const cell = requireRecord(valueCell, 'overview punchcard cell');
      assertExactKeys(cell, ['cost', 'sessions'], 'overview punchcard cell');
      requireFiniteNumber(cell.cost, 'overview punchcard cell.cost');
      requireNonNegativeSafeInteger(cell.sessions, 'overview punchcard cell.sessions');
    }
  }
};

const assertOverviewRecords = (value: unknown): void => {
  if (value === null) {
    return;
  }
  const records = requireRecord(value, 'overview records');
  assertExactKeys(records, ['busiest', 'longest', 'streak', 'streakEnd', 'topCost'], 'overview records');
  if (records.busiest !== null) {
    const busiest = requireRecord(records.busiest, 'overview records.busiest');
    assertExactKeys(busiest, ['cost', 'date', 'sessions'], 'overview records.busiest');
    requireFiniteNumber(busiest.cost, 'overview records.busiest.cost');
    requireIsoTimestamp(busiest.date, 'overview records.busiest.date');
    requirePositiveSafeInteger(busiest.sessions, 'overview records.busiest.sessions');
  }
  if (records.longest !== null) {
    parseSessionPresentationRow(records.longest, 'overview records.longest');
  }
  requireNonNegativeSafeInteger(records.streak, 'overview records.streak');
  if (records.streakEnd !== null) {
    requireIsoTimestamp(records.streakEnd, 'overview records.streakEnd');
  }
  if (records.topCost !== null) {
    parseSessionPresentationRow(records.topCost, 'overview records.topCost');
  }
};

const assertAxisDomain = (value: unknown, label: string): void => {
  const domain = requireRecord(value, label);
  assertExactKeys(domain, ['max', 'min'], label);
  const maximum = requireFiniteNumber(domain.max, `${label}.max`, { minimum: Number.NEGATIVE_INFINITY });
  const minimum = requireFiniteNumber(domain.min, `${label}.min`, { minimum: Number.NEGATIVE_INFINITY });
  if (minimum > maximum) {
    throw new Error(`${label} minimum exceeds maximum`);
  }
};

const assertAxisTicks = (value: unknown, label: string, maximumLength: number): void => {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new Error(`${label} exceeds its presentation bound`);
  }
  for (const rawTick of value) {
    const tick = requireRecord(rawTick, label);
    assertExactKeys(tick, ['label', 'value'], label);
    requireString(tick.label, `${label}.label`);
    requireFiniteNumber(tick.value, `${label}.value`);
  }
};

const assertSessionShape = (value: unknown): void => {
  if (value === null) {
    return;
  }
  const shape = requireRecord(value, 'overview session shape');
  assertExactKeys(
    shape,
    ['harnesses', 'harnessSummaries', 'outliers', 'points', 'totalPoints', 'xDomain', 'xTicks', 'yDomain', 'yTicks'],
    'overview session shape',
  );
  assertStringArray(shape.harnesses, 'overview session shape.harnesses', 240);
  if (!Array.isArray(shape.harnessSummaries) || shape.harnessSummaries.length > 240) {
    throw new Error('overview session shape harness summaries exceed their presentation bound');
  }
  for (const rawSummary of shape.harnessSummaries) {
    const summary = requireRecord(rawSummary, 'overview session shape harness summary');
    assertExactKeys(
      summary,
      ['costMax', 'costMin', 'durationMax', 'durationMin', 'groups', 'harness', 'sessions'],
      'overview session shape harness summary',
    );
    for (const key of ['costMax', 'costMin', 'durationMax', 'durationMin'] as const) {
      requireFiniteNumber(summary[key], `overview session shape harness summary.${key}`);
    }
    requireNonNegativeSafeInteger(summary.groups, 'overview session shape harness summary.groups');
    requireString(summary.harness, 'overview session shape harness summary.harness');
    requireNonNegativeSafeInteger(summary.sessions, 'overview session shape harness summary.sessions');
  }
  if (!Array.isArray(shape.outliers) || shape.outliers.length > 6) {
    throw new Error('overview session shape outliers exceed their presentation bound');
  }
  for (const outlier of shape.outliers) {
    assertOverviewSessionItem(outlier, 'overview session shape outlier');
  }
  if (!Array.isArray(shape.points) || shape.points.length > 240) {
    throw new Error('overview session shape points exceed their presentation bound');
  }
  for (const point of shape.points) {
    assertOverviewSessionItem(point, 'overview session shape point', true);
  }
  requireNonNegativeSafeInteger(shape.totalPoints, 'overview session shape.totalPoints');
  assertAxisDomain(shape.xDomain, 'overview session shape.xDomain');
  assertAxisTicks(shape.xTicks, 'overview session shape.xTicks', 4);
  assertAxisDomain(shape.yDomain, 'overview session shape.yDomain');
  assertAxisTicks(shape.yTicks, 'overview session shape.yTicks', 5);
};

const assertAdvancedSummary = (value: unknown): void => {
  if (value === null) {
    return;
  }
  const summary = requireRecord(value, 'overview advanced summary');
  assertExactKeys(summary, ['hasPunchcard', 'hasSessionShape', 'summary'], 'overview advanced summary');
  if (typeof summary.hasPunchcard !== 'boolean' || typeof summary.hasSessionShape !== 'boolean') {
    throw new Error('overview advanced summary flags must be booleans');
  }
  requireString(summary.summary, 'overview advanced summary.summary');
};

const assertOverviewView = (value: unknown, includeAdvanced: boolean): void => {
  const view = requireRecord(value, 'overview view');
  assertExactKeys(
    view,
    ['advancedSummary', 'heatmap', 'previousSummary', 'punchcard', 'records', 'sessionShape', 'topSessions'],
    'overview view',
  );
  assertAdvancedSummary(view.advancedSummary);
  assertHeatmap(view.heatmap);
  if (view.previousSummary !== null) {
    assertFocusedSummary(view.previousSummary, 'overview previous summary');
  }
  assertPunchcard(view.punchcard);
  assertOverviewRecords(view.records);
  assertSessionShape(view.sessionShape);
  if (!Array.isArray(view.topSessions) || view.topSessions.length > 5) {
    throw new Error('overview top sessions must be a bounded array');
  }
  for (const item of view.topSessions) {
    assertOverviewSessionItem(item, 'overview top session');
  }
  if (view.advancedSummary !== null) {
    const advancedSummary = requireRecord(view.advancedSummary, 'overview advanced summary');
    if (
      advancedSummary.hasPunchcard !== (view.punchcard !== null) ||
      advancedSummary.hasSessionShape !== (view.sessionShape !== null)
    ) {
      throw new Error('overview advanced summary flags do not match the included analyses');
    }
  } else if (view.punchcard !== null || view.sessionShape !== null) {
    throw new Error('overview advanced summary is missing for included analyses');
  }
  if (!includeAdvanced && (view.advancedSummary !== null || view.punchcard !== null || view.sessionShape !== null)) {
    throw new Error('overview contains advanced analysis that was not requested');
  }
};

const ANALYTICS_GROUP_KEYS = [
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
] as const;

const assertAnalyticsGroup = (value: unknown, label: string): void => {
  const group = requireRecord(value, label);
  assertExactKeys(group, ANALYTICS_GROUP_KEYS, label);
  for (const key of ['harness', 'key', 'provider'] as const) {
    requireString(group[key], `${label}.${key}`);
  }
  for (const key of ANALYTICS_GROUP_KEYS) {
    if (key === 'harness' || key === 'key' || key === 'provider') {
      continue;
    }
    if (key === 'costPer100Lines' || key === 'costPerSession' || key === 'medianCost') {
      if (group[key] !== null) {
        requireFiniteNumber(group[key], `${label}.${key}`);
      }
      continue;
    }
    requireFiniteNumber(group[key], `${label}.${key}`, {
      maximum: key === 'cacheHitPct' || key === 'costPercent' ? 100 : Number.POSITIVE_INFINITY,
    });
  }
  for (const key of ['ambiguous', 'priced', 'sessions', 'unpriced', 'usageUnavailable'] as const) {
    requireNonNegativeSafeInteger(group[key], `${label}.${key}`);
  }
};

const ANALYTICS_SUMMARY_KEYS = [
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
] as const;

const assertAnalyticsSummary = (value: unknown, label: string): void => {
  const summary = requireRecord(value, label);
  assertExactKeys(summary, ANALYTICS_SUMMARY_KEYS, label);
  for (const key of ['averageDurationMs', 'costPer100Lines'] as const) {
    if (summary[key] !== null) {
      requireFiniteNumber(summary[key], `${label}.${key}`);
    }
  }
  for (const key of [
    'durationMs',
    'lineCount',
    'linesA',
    'linesD',
    'meanCost',
    'medianCost',
    'tools',
    'totalCost',
    'turns',
  ] as const) {
    requireFiniteNumber(summary[key], `${label}.${key}`);
  }
  for (const key of ['durationRows', 'pricedCount', 'recentSessions', 'sessionCount', 'unpricedCount'] as const) {
    requireNonNegativeSafeInteger(summary[key], `${label}.${key}`);
  }
  for (const key of ['byHarness', 'byModel', 'byProvider'] as const) {
    if (!Array.isArray(summary[key])) {
      throw new Error(`${label}.${key} must be an array`);
    }
    for (const [index, group] of summary[key].entries()) {
      assertAnalyticsGroup(group, `${label}.${key}[${index}]`);
    }
  }
};

const PROJECT_GROUP_KEYS = [
  'cache',
  'cost',
  'fresh',
  'key',
  'linesAdded',
  'linesDeleted',
  'priced',
  'sessions',
  'tools',
  'turns',
] as const;

const assertFocusedProjectGroup = (value: unknown, label: string): void => {
  const group = requireRecord(value, label);
  assertExactKeys(group, PROJECT_GROUP_KEYS, label);
  requireString(group.key, `${label}.key`);
  for (const key of PROJECT_GROUP_KEYS) {
    if (key !== 'key') {
      requireFiniteNumber(group[key], `${label}.${key}`);
    }
  }
  for (const key of ['priced', 'sessions'] as const) {
    requireNonNegativeSafeInteger(group[key], `${label}.${key}`);
  }
};

const assertBreakdownGroups = (value: unknown): void => {
  const groups = requireRecord(value, 'breakdown groups');
  assertExactKeys(groups, ['harnesses', 'models', 'projects', 'providers'], 'breakdown groups');
  for (const key of ['harnesses', 'models', 'providers'] as const) {
    if (!Array.isArray(groups[key])) {
      throw new Error(`breakdown groups.${key} must be an array`);
    }
    for (const [index, group] of groups[key].entries()) {
      assertAnalyticsGroup(group, `breakdown groups.${key}[${index}]`);
    }
  }
  if (!Array.isArray(groups.projects)) {
    throw new Error('breakdown groups.projects must be an array');
  }
  for (const [index, group] of groups.projects.entries()) {
    assertFocusedProjectGroup(group, `breakdown groups.projects[${index}]`);
  }
};

const assertProjectGroupConfigs = (value: unknown): void => {
  if (!Array.isArray(value)) {
    throw new Error('breakdown context.projectGroupConfigs must be an array');
  }
  for (const rawConfig of value) {
    const config = requireRecord(rawConfig, 'breakdown project group config');
    assertExactKeys(config, ['id', 'name', 'sources'], 'breakdown project group config');
    if (!Array.isArray(config.sources)) {
      throw new Error('breakdown project group config sources must be an array');
    }
    for (const rawSource of config.sources) {
      const source = requireRecord(rawSource, 'breakdown project group selector');
      assertAllowedKeys(
        source,
        [],
        ['gitRemote', 'machineId', 'project', 'sourcePath'],
        'breakdown project group selector',
      );
    }
  }
  parseProjectGroupConfigs(value);
};

const assertReportProjectSource = (value: unknown, label: string): void => {
  const source = requireRecord(value, label);
  assertExactKeys(
    source,
    ['gitRemote', 'id', 'machineId', 'machineLabel', 'project', 'sessions', 'sourcePath', 'tokens'],
    label,
  );
  for (const key of ['gitRemote', 'id', 'machineId', 'machineLabel', 'project', 'sourcePath'] as const) {
    requireString(source[key], `${label}.${key}`);
  }
  requireNonNegativeSafeInteger(source.sessions, `${label}.sessions`);
  requireFiniteNumber(source.tokens, `${label}.tokens`);
};

const assertReportProjectGroup = (value: unknown, label: string): void => {
  const group = requireRecord(value, label);
  assertExactKeys(
    group,
    [
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
    ],
    label,
  );
  if (typeof group.grouped !== 'boolean') {
    throw new Error(`${label}.grouped must be a boolean`);
  }
  requireString(group.id, `${label}.id`);
  requireString(group.name, `${label}.name`);
  for (const key of ['cache', 'cost', 'fresh', 'linesAdded', 'linesDeleted', 'tokens', 'tools', 'turns'] as const) {
    requireFiniteNumber(group[key], `${label}.${key}`);
  }
  requireNonNegativeSafeInteger(group.priced, `${label}.priced`);
  requireNonNegativeSafeInteger(group.sessions, `${label}.sessions`);
  if (!Array.isArray(group.sources)) {
    throw new Error(`${label}.sources must be an array`);
  }
  for (const [index, source] of group.sources.entries()) {
    assertReportProjectSource(source, `${label}.sources[${index}]`);
  }
};

const assertBreakdownContext = (value: unknown): void => {
  const context = requireRecord(value, 'breakdown context');
  assertAllowedKeys(
    context,
    ['cursorCommitAttribution'],
    ['projectGroupConfigs', 'projectGroups', 'warnings'],
    'breakdown context',
  );
  if (
    !(
      Array.isArray(context.cursorCommitAttribution) &&
      context.cursorCommitAttribution.every(isCursorCommitAttributionRow)
    )
  ) {
    throw new Error('breakdown context.cursorCommitAttribution is invalid');
  }
  if (context.projectGroupConfigs !== undefined) {
    assertProjectGroupConfigs(context.projectGroupConfigs);
  }
  if (context.projectGroups !== undefined) {
    if (!Array.isArray(context.projectGroups)) {
      throw new Error('breakdown context.projectGroups must be an array');
    }
    for (const [index, group] of context.projectGroups.entries()) {
      assertReportProjectGroup(group, `breakdown context.projectGroups[${index}]`);
    }
  }
  if (context.warnings !== undefined && !isUsageReportWarnings(context.warnings)) {
    throw new Error('breakdown context.warnings is invalid');
  }
};

const assertBootstrapSupport = (value: unknown): void => {
  const support = requireRecord(value, 'bootstrap support');
  assertAllowedKeys(
    support,
    ['analytics', 'filters', 'generatedAt', 'omittedRows'],
    ['datasets', 'warnings'],
    'bootstrap support',
  );
  assertAnalyticsSummary(support.analytics, 'bootstrap support.analytics');
  assertReportFilters(support.filters, 'bootstrap support.filters');
  requireIsoTimestamp(support.generatedAt, 'bootstrap support.generatedAt');
  requireNonNegativeSafeInteger(support.omittedRows, 'bootstrap support.omittedRows');
  if (support.datasets !== undefined) {
    const datasets = requireRecord(support.datasets, 'bootstrap support.datasets');
    assertAllowedKeys(datasets, [], ['providerStatus'], 'bootstrap support.datasets');
    if (datasets.providerStatus !== undefined && parseProviderStatusDataset(datasets.providerStatus) === null) {
      throw new Error('bootstrap support.datasets.providerStatus is invalid');
    }
  }
  if (support.warnings !== undefined && !isUsageReportWarnings(support.warnings)) {
    throw new Error('bootstrap support.warnings is invalid');
  }
};

const assertReportDatasets = (value: unknown, label: string): void => {
  const datasets = requireRecord(value, label);
  if (
    datasets.cursorCommitAttribution !== undefined &&
    !(
      Array.isArray(datasets.cursorCommitAttribution) &&
      datasets.cursorCommitAttribution.every(isCursorCommitAttributionRow)
    )
  ) {
    throw new Error(`${label}.cursorCommitAttribution is invalid`);
  }
  if (datasets.providerStatus !== undefined && parseProviderStatusDataset(datasets.providerStatus) === null) {
    throw new Error(`${label}.providerStatus is invalid`);
  }
};

const parseCompatibilityPayload = (value: unknown): UsageReportPayload => {
  const payload = requireRecord(value, 'HTML compatibility payload');
  assertAllowedKeys(
    payload,
    ['analytics', 'filters', 'generatedAt', 'omittedRows', 'rows', 'tableRows'],
    ['datasets', 'facets', 'projectGroupConfigs', 'projectGroups', 'warnings'],
    'HTML compatibility payload',
  );
  assertAnalyticsSummary(payload.analytics, 'HTML compatibility payload.analytics');
  assertReportFilters(payload.filters, 'HTML compatibility payload.filters');
  requireIsoTimestamp(payload.generatedAt, 'HTML compatibility payload.generatedAt');
  requireNonNegativeSafeInteger(payload.omittedRows, 'HTML compatibility payload.omittedRows');
  if (!Array.isArray(payload.rows)) {
    throw new Error('HTML compatibility payload.rows must be an array');
  }
  for (const [index, row] of payload.rows.entries()) {
    if (!isSerializedUsageRowShape(row)) {
      throw new Error(`HTML compatibility payload.rows[${index}] is not a valid serialized usage row`);
    }
  }
  if (!Array.isArray(payload.tableRows)) {
    throw new Error('HTML compatibility payload.tableRows must be an array');
  }
  for (const [index, row] of payload.tableRows.entries()) {
    if (!isSerializedUsageRowShape(row)) {
      throw new Error(`HTML compatibility payload.tableRows[${index}] is not a valid serialized usage row`);
    }
  }
  if (payload.datasets !== undefined) {
    assertReportDatasets(payload.datasets, 'HTML compatibility payload.datasets');
  }
  if (payload.facets !== undefined) {
    const facets = requireRecord(payload.facets, 'HTML compatibility payload.facets');
    if (facets.providerStatus !== undefined && parseProviderStatusDataset(facets.providerStatus) === null) {
      throw new Error('HTML compatibility payload.facets.providerStatus is invalid');
    }
  }
  if (payload.projectGroupConfigs !== undefined) {
    assertProjectGroupConfigs(payload.projectGroupConfigs);
  }
  if (payload.projectGroups !== undefined) {
    if (!Array.isArray(payload.projectGroups)) {
      throw new Error('HTML compatibility payload.projectGroups must be an array');
    }
    for (const [index, group] of payload.projectGroups.entries()) {
      assertReportProjectGroup(group, `HTML compatibility payload.projectGroups[${index}]`);
    }
  }
  if (payload.warnings !== undefined && !isUsageReportWarnings(payload.warnings)) {
    throw new Error('HTML compatibility payload.warnings is invalid');
  }
  return payload as unknown as UsageReportPayload;
};

const assertSupportTruncation = (value: unknown): void => {
  const truncation = requireRecord(value, 'support truncation');
  const keys = [
    'filterProjectOmitted',
    'filterSinceOmitted',
    'harnessOptionsOmitted',
    'machineOptionsOmitted',
    'providerRowsOmitted',
    'providerStatusesOmitted',
    'warningsOmitted',
  ] as const;
  assertExactKeys(truncation, keys, 'support truncation');
  for (const key of keys) {
    requireNonNegativeSafeInteger(truncation[key], `support truncation.${key}`);
  }
};

const assertFocusedDateDomain = (value: unknown, label: string): void => {
  if (value === null) {
    return;
  }
  const domain = requireRecord(value, label);
  assertExactKeys(domain, ['first', 'last'], label);
  const first = requireIsoTimestamp(domain.first, `${label}.first`);
  const last = requireIsoTimestamp(domain.last, `${label}.last`);
  if (Date.parse(first) > Date.parse(last)) {
    throw new Error(`${label}.first must not be later than ${label}.last`);
  }
};

export function parseFocusedReportQueryResult(
  kind: 'overview',
  value: unknown,
  request: FocusedOverviewRequest,
): FocusedOverviewResult;
export function parseFocusedReportQueryResult(
  kind: 'breakdown',
  value: unknown,
  request: FocusedBreakdownRequest,
): FocusedBreakdownResult;
export function parseFocusedReportQueryResult(
  kind: 'csv',
  value: unknown,
  request: FocusedCsvRequest,
): FocusedCsvResult;
export function parseFocusedReportQueryResult(
  kind: 'html-payload',
  value: unknown,
  request: FocusedRevisionRequest,
): FocusedHtmlPayloadResult;
export function parseFocusedReportQueryResult(
  kind: 'support',
  value: unknown,
  request: FocusedRevisionRequest,
): FocusedSupportResult;
export function parseFocusedReportQueryResult(
  kind: FocusedReportQueryKind,
  value: unknown,
  request: FocusedBreakdownRequest | FocusedCsvRequest | FocusedOverviewRequest | FocusedRevisionRequest,
): FocusedReportQueryResult;
export function parseFocusedReportQueryResult(
  kind: FocusedReportQueryKind,
  value: unknown,
  request: FocusedBreakdownRequest | FocusedCsvRequest | FocusedOverviewRequest | FocusedRevisionRequest,
): FocusedReportQueryResult {
  if (kind === 'overview') {
    const parsed = parseFocusedOverviewRequest(request);
    const record = assertResultEnvelope(
      value,
      ['dateDomain', 'metadata', 'requestFingerprint', 'revision', 'summary', 'timeline', 'view'],
      parsed.query.revision,
      focusedOverviewFingerprint(parsed),
    );
    assertFocusedDateDomain(record.dateDomain, 'overview dateDomain');
    const metadata = requireRecord(record.metadata, 'overview metadata');
    assertExactKeys(metadata, ['filters', 'generatedAt', 'omittedRows'], 'overview metadata');
    assertReportFilters(metadata.filters, 'overview metadata.filters');
    requireIsoTimestamp(metadata.generatedAt, 'overview metadata.generatedAt');
    requireNonNegativeSafeInteger(metadata.omittedRows, 'overview metadata.omittedRows');
    assertFocusedSummary(record.summary, 'overview summary');
    assertFocusedTimeline(record.timeline, parsed.timeline);
    assertOverviewView(record.view, parsed.includeAdvanced);
    return record as unknown as FocusedOverviewResult;
  }
  if (kind === 'breakdown') {
    const parsed = parseFocusedBreakdownRequest(request);
    const record = assertResultEnvelope(
      value,
      ['context', 'groups', 'requestFingerprint', 'revision'],
      parsed.query.revision,
      focusedBreakdownFingerprint(parsed),
    );
    assertBreakdownGroups(record.groups);
    assertBreakdownContext(record.context);
    return record as unknown as FocusedBreakdownResult;
  }
  if (kind === 'csv') {
    const parsed = parseFocusedCsvRequest(request);
    const record = assertResultEnvelope(
      value,
      ['csv', 'requestFingerprint', 'revision', 'rowCount'],
      parsed.query.revision,
      focusedCsvFingerprint(parsed),
    );
    if (typeof record.csv !== 'string' || !Number.isSafeInteger(record.rowCount) || Number(record.rowCount) < 0) {
      throw new Error('Focused CSV result is invalid');
    }
    return record as unknown as FocusedCsvResult;
  }
  const parsed = parseFocusedRevisionRequest(request);
  if (kind === 'html-payload') {
    const record = assertResultEnvelope(
      value,
      ['payload', 'requestFingerprint', 'revision', 'rowCount'],
      parsed.revision,
      focusedRevisionFingerprint(kind, parsed),
    );
    const payload = parseCompatibilityPayload(record.payload);
    if (requireNonNegativeSafeInteger(record.rowCount, 'HTML compatibility payload rowCount') !== payload.rows.length) {
      throw new Error('Focused HTML compatibility payload is invalid');
    }
    return { ...record, payload } as unknown as FocusedHtmlPayloadResult;
  }
  const record = assertResultEnvelope(
    value,
    ['dateDomain', 'filterOptions', 'providerRows', 'requestFingerprint', 'revision', 'support', 'truncation'],
    parsed.revision,
    focusedRevisionFingerprint(kind, parsed),
  );
  assertFocusedDateDomain(record.dateDomain, 'support dateDomain');
  const options = requireRecord(record.filterOptions, 'support filter options');
  assertExactKeys(options, ['harness', 'machine', 'truncated'], 'support filter options');
  if (
    !Array.isArray(options.harness) ||
    options.harness.length > 100 ||
    !Array.isArray(options.machine) ||
    options.machine.length > 100 ||
    options.harness.some((entry) => typeof entry !== 'string') ||
    typeof options.truncated !== 'boolean' ||
    options.machine.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Support filter options are invalid');
  }
  if (!Array.isArray(record.providerRows) || record.providerRows.length > 100) {
    throw new Error('Support provider rows are invalid');
  }
  const providerRows = record.providerRows.map((row, index) =>
    parseSessionPresentationRow(row, `support providerRows[${index}]`),
  );
  assertBootstrapSupport(record.support);
  assertSupportTruncation(record.truncation);
  return { ...record, providerRows } as unknown as FocusedSupportResult;
}
