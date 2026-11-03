import { parseConstellation } from './constellation';
import { isCursorCommitAttributionRow } from './datasets';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportQueryKind,
  type FocusedReportQueryResult,
  type FocusedReportSupport,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from './focused-report-query';
import {
  assertAllowedKeys,
  assertExactKeys,
  isRecord,
  MAX_EXECUTIVE_GROUPS,
  MAX_TIMELINE_SERIES,
  OTHER_MEMBER_SUMMARY_LIMIT,
  requireRecord,
} from './focused-report-shared';
import { parseTokenFlow } from './observatory';
import { parseProjectGroupConfigs } from './project-group';
import { type ApiPriceMeasurement, parseApiPriceMeasurement } from './provenance';
import { parseProviderStatusDataset } from './provider-status';
import { parseUsageReportPayload } from './report-data';
import { isStrictIsoTimestamp, isUsageReportWarnings } from './serialized-usage-validation';
import { parseSessionPresentationRow } from './session-query';
import { isReportTimeZone } from './time-zone';
import { isOriginProvenanceKind, type OriginProvenanceKind } from './types';

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

const assertApiPriceMeasurement = (value: unknown, label: string, expectedKnownCost?: number): void => {
  let measurement: ApiPriceMeasurement;
  try {
    measurement = parseApiPriceMeasurement(value);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'API price measurement is invalid';
    throw new Error(`${label}: ${reason}`, { cause });
  }
  if (expectedKnownCost !== undefined && measurement.knownCost !== expectedKnownCost) {
    throw new Error(`${label}.knownCost must match its aggregate cost`);
  }
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
  'priceMeasurement',
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
    if (key !== 'priceMeasurement') {
      requireFiniteNumber(summary[key], `${label}.${key}`);
    }
  }
  assertApiPriceMeasurement(summary.priceMeasurement, `${label}.priceMeasurement`, Number(summary.totalCost));
  for (const key of ['pricedSessions', 'rtkSessions', 'sessionCount', 'unknownActual'] as const) {
    requireNonNegativeSafeInteger(summary[key], `${label}.${key}`);
  }
};

const assertTimelineMemberSummaries = (value: unknown, label: string): void => {
  if (!Array.isArray(value) || value.length > OTHER_MEMBER_SUMMARY_LIMIT) {
    throw new Error(`${label} exceeds its presentation bound`);
  }
  for (const [index, entry] of value.entries()) {
    const summary = requireRecord(entry, `${label}[${index}]`);
    assertAllowedKeys(summary, ['label', 'sessions', 'total'], [], `${label}[${index}]`);
    requireString(summary.label, `${label}[${index}].label`);
    requireNonNegativeSafeInteger(summary.sessions, `${label}[${index}].sessions`);
    requireFiniteNumber(summary.total, `${label}[${index}].total`);
  }
};

const assertTimelineSeries = (value: unknown): Set<string> => {
  if (!Array.isArray(value) || value.length > MAX_TIMELINE_SERIES) {
    throw new Error('overview timeline.series exceeds its presentation bound');
  }
  const keys = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const series = requireRecord(entry, `overview timeline.series[${index}]`);
    assertAllowedKeys(
      series,
      ['key', 'label', 'priceMeasurement', 'sessions', 'tokens', 'total'],
      ['memberKeys', 'memberSummaries'],
      'overview timeline series',
    );
    const key = requireString(series.key, 'overview timeline series.key');
    requireString(series.label, 'overview timeline series.label');
    requireNonNegativeSafeInteger(series.sessions, 'overview timeline series.sessions');
    requireNonNegativeSafeInteger(series.tokens, 'overview timeline series.tokens');
    const seriesTotal = requireFiniteNumber(series.total, 'overview timeline series.total');
    assertApiPriceMeasurement(series.priceMeasurement, 'overview timeline series.priceMeasurement', seriesTotal);
    if (series.memberKeys !== undefined) {
      assertStringArray(series.memberKeys, 'overview timeline series.memberKeys');
    }
    if (series.memberSummaries !== undefined) {
      assertTimelineMemberSummaries(series.memberSummaries, 'overview timeline series.memberSummaries');
    }
    if (keys.has(key)) {
      throw new Error('overview timeline series keys must be unique');
    }
    keys.add(key);
  }
  return keys;
};

const assertTimelineGap = (value: unknown, label: string): void => {
  if (value === null) {
    return;
  }
  const gap = requireRecord(value, label);
  assertExactKeys(gap, ['causes', 'priceMeasurement', 'sessions', 'tokens', 'total'], label);
  requireNonNegativeSafeInteger(gap.sessions, `${label}.sessions`);
  requireNonNegativeSafeInteger(gap.tokens, `${label}.tokens`);
  const total = requireFiniteNumber(gap.total, `${label}.total`);
  assertApiPriceMeasurement(gap.priceMeasurement, `${label}.priceMeasurement`, total);
  if (!Array.isArray(gap.causes) || gap.causes.length > 3) {
    throw new Error(`${label}.causes is invalid`);
  }
  const kinds = new Set<OriginProvenanceKind>();
  for (const causeValue of gap.causes) {
    const causeLabel = `${label}.causes[]`;
    const cause = requireRecord(causeValue, causeLabel);
    assertExactKeys(cause, ['kind', 'sessions'], causeLabel);
    if (!isOriginProvenanceKind(cause.kind) || kinds.has(cause.kind)) {
      throw new Error(`${causeLabel}.kind is invalid`);
    }
    kinds.add(cause.kind);
    requireNonNegativeSafeInteger(cause.sessions, `${causeLabel}.sessions`);
  }
};

const assertTimelineBuckets = (value: unknown, seriesKeys: ReadonlySet<string>): void => {
  if (!Array.isArray(value)) {
    throw new Error('overview timeline.buckets must be an array');
  }
  for (const [index, entry] of value.entries()) {
    const bucket = requireRecord(entry, `overview timeline.buckets[${index}]`);
    assertExactKeys(
      bucket,
      ['byKey', 'date', 'priceMeasurement', 'sessions', 'tokens', 'total', 'unclassified'],
      'overview timeline bucket',
    );
    requireIsoTimestamp(bucket.date, 'overview timeline bucket.date');
    requireNonNegativeSafeInteger(bucket.sessions, 'overview timeline bucket.sessions');
    requireNonNegativeSafeInteger(bucket.tokens, 'overview timeline bucket.tokens');
    const bucketTotal = requireFiniteNumber(bucket.total, 'overview timeline bucket.total');
    assertApiPriceMeasurement(bucket.priceMeasurement, 'overview timeline bucket.priceMeasurement', bucketTotal);
    assertTimelineGap(bucket.unclassified, 'overview timeline bucket.unclassified');
    const byKey = requireRecord(bucket.byKey, 'overview timeline bucket.byKey');
    if (Object.keys(byKey).length > MAX_TIMELINE_SERIES) {
      throw new Error('overview timeline bucket.byKey exceeds its presentation bound');
    }
    for (const [key, rawTotals] of Object.entries(byKey)) {
      if (!seriesKeys.has(key)) {
        throw new Error('overview timeline bucket contains an unknown series key');
      }
      const totals = requireRecord(rawTotals, `overview timeline bucket.byKey.${key}`);
      assertExactKeys(totals, ['cost', 'priceMeasurement', 'sessions', 'tokens'], 'overview timeline bucket entry');
      const entryCost = requireFiniteNumber(totals.cost, 'overview timeline bucket entry.cost');
      assertApiPriceMeasurement(totals.priceMeasurement, 'overview timeline bucket entry.priceMeasurement', entryCost);
      requireNonNegativeSafeInteger(totals.sessions, 'overview timeline bucket entry.sessions');
      requireNonNegativeSafeInteger(totals.tokens, 'overview timeline bucket entry.tokens');
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
      'grandTokens',
      'grandTotal',
      'granularity',
      'last',
      'maxBucketSessions',
      'maxBucketTokens',
      'maxBucketTotal',
      'priceMeasurement',
      'series',
      'unclassified',
    ],
    'overview timeline',
  );
  if (timeline.dimension !== expected.dimension || timeline.granularity !== expected.granularity) {
    throw new Error('overview timeline does not match the requested dimension and granularity');
  }
  requireIsoTimestamp(timeline.first, 'overview timeline.first');
  requireIsoTimestamp(timeline.last, 'overview timeline.last');
  requireNonNegativeSafeInteger(timeline.grandSessions, 'overview timeline.grandSessions');
  requireNonNegativeSafeInteger(timeline.grandTokens, 'overview timeline.grandTokens');
  const grandTotal = requireFiniteNumber(timeline.grandTotal, 'overview timeline.grandTotal');
  assertApiPriceMeasurement(timeline.priceMeasurement, 'overview timeline.priceMeasurement', grandTotal);
  requireNonNegativeSafeInteger(timeline.maxBucketSessions, 'overview timeline.maxBucketSessions');
  requireNonNegativeSafeInteger(timeline.maxBucketTokens, 'overview timeline.maxBucketTokens');
  requireFiniteNumber(timeline.maxBucketTotal, 'overview timeline.maxBucketTotal');
  assertTimelineBuckets(timeline.buckets, assertTimelineSeries(timeline.series));
  assertTimelineGap(timeline.unclassified, 'overview timeline.unclassified');
};

const assertOverviewSessionItem = (value: unknown, label: string, requireAggregateCount = false): void => {
  const item = requireRecord(value, label);
  const requiredKeys = ['costApprox', 'costKnown', 'durationMs', 'harness', 'kind', 'label', 'row', 'sessionCount'];
  assertExactKeys(item, requireAggregateCount ? [...requiredKeys, 'aggregateCount'] : requiredKeys, label);
  requireFiniteNumber(item.costApprox, `${label}.costApprox`);
  if (typeof item.costKnown !== 'boolean') {
    throw new Error(`${label}.costKnown must be a boolean`);
  }
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
      assertExactKeys(day, ['cost', 'date', 'level', 'priceMeasurement', 'sessions'], 'overview heatmap day');
      const dayCost = requireFiniteNumber(day.cost, 'overview heatmap day.cost');
      assertApiPriceMeasurement(day.priceMeasurement, 'overview heatmap day.priceMeasurement', dayCost);
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
    assertOverviewSessionItem(records.longest, 'overview records.longest');
  }
  requireNonNegativeSafeInteger(records.streak, 'overview records.streak');
  if (records.streakEnd !== null) {
    requireIsoTimestamp(records.streakEnd, 'overview records.streakEnd');
  }
  if (records.topCost !== null) {
    assertOverviewSessionItem(records.topCost, 'overview records.topCost');
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

const assertExecutiveGroups = (value: unknown, label: string): void => {
  if (!Array.isArray(value) || value.length > MAX_EXECUTIVE_GROUPS) {
    throw new Error(`${label} must be an array of at most ${MAX_EXECUTIVE_GROUPS} groups`);
  }
  const keys = new Set<string>();
  for (const [index, rawGroup] of value.entries()) {
    const groupLabel = `${label}[${index}]`;
    const group = requireRecord(rawGroup, groupLabel);
    assertExactKeys(group, ['key', 'label', 'priceMeasurement', 'processedTokens', 'sessions', 'total'], groupLabel);
    const key = requireString(group.key, `${groupLabel}.key`);
    const displayLabel = requireString(group.label, `${groupLabel}.label`);
    if (key.length === 0 || key !== key.trim() || keys.has(key)) {
      throw new Error(`${label} keys must be non-empty, trimmed, and unique`);
    }
    if (displayLabel.length === 0 || displayLabel !== displayLabel.trim()) {
      throw new Error(`${groupLabel}.label must be a non-empty trimmed string`);
    }
    keys.add(key);
    requireNonNegativeSafeInteger(group.sessions, `${groupLabel}.sessions`);
    requireFiniteNumber(group.processedTokens, `${groupLabel}.processedTokens`);
    const total = requireFiniteNumber(group.total, `${groupLabel}.total`);
    assertApiPriceMeasurement(group.priceMeasurement, `${groupLabel}.priceMeasurement`, total);
  }
};

const assertExecutiveOverview = (value: unknown): void => {
  const executive = requireRecord(value, 'overview executive');
  assertExactKeys(executive, ['harnesses', 'models'], 'overview executive');
  assertExecutiveGroups(executive.harnesses, 'overview executive.harnesses');
  assertExecutiveGroups(executive.models, 'overview executive.models');
};

const assertOverviewView = (value: unknown, includeAdvanced: boolean): void => {
  const view = requireRecord(value, 'overview view');
  assertExactKeys(
    view,
    [
      'advancedSummary',
      'executive',
      'heatmap',
      'previousSummary',
      'punchcard',
      'records',
      'sessionShape',
      'topSessions',
    ],
    'overview view',
  );
  assertAdvancedSummary(view.advancedSummary);
  assertExecutiveOverview(view.executive);
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
  'unpricedFreshTokens',
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
  for (const key of [
    'ambiguous',
    'priced',
    'sessions',
    'unpriced',
    'unpricedFreshTokens',
    'usageUnavailable',
  ] as const) {
    requireNonNegativeSafeInteger(group[key], `${label}.${key}`);
  }
  if (group.unpriced === 0 && group.unpricedFreshTokens !== 0) {
    throw new Error(`${label}.unpricedFreshTokens requires an unpriced session`);
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
  'label',
  'lineMeasurement',
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
  requireString(group.label, `${label}.label`);
  for (const key of PROJECT_GROUP_KEYS) {
    if (key !== 'key' && key !== 'label' && key !== 'lineMeasurement') {
      requireFiniteNumber(group[key], `${label}.${key}`);
    }
  }
  for (const key of ['priced', 'sessions'] as const) {
    requireNonNegativeSafeInteger(group[key], `${label}.${key}`);
  }
  const lineMeasurement = requireRecord(group.lineMeasurement, `${label}.lineMeasurement`);
  assertExactKeys(lineMeasurement, ['measuredSessions', 'totalSessions'], `${label}.lineMeasurement`);
  const measuredSessions = requireNonNegativeSafeInteger(
    lineMeasurement.measuredSessions,
    `${label}.lineMeasurement.measuredSessions`,
  );
  const totalSessions = requireNonNegativeSafeInteger(
    lineMeasurement.totalSessions,
    `${label}.lineMeasurement.totalSessions`,
  );
  if (measuredSessions > totalSessions || totalSessions !== group.sessions) {
    throw new Error(`${label}.lineMeasurement is inconsistent with sessions`);
  }
};

const assertBreakdownGroups = (value: unknown): void => {
  const groups = requireRecord(value, 'breakdown groups');
  assertExactKeys(groups, ['harnesses', 'harnessProviders', 'models', 'projects', 'providers'], 'breakdown groups');
  for (const key of ['harnesses', 'harnessProviders', 'models', 'providers'] as const) {
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

const assertFocusedMachineFreshness = (value: unknown): void => {
  const freshness = requireRecord(value, 'support machine freshness');
  requireIsoTimestamp(freshness.observedAt, 'support machine freshness.observedAt');
  requireNonNegativeSafeInteger(freshness.omittedMachines, 'support machine freshness.omittedMachines');
  requireNonNegativeSafeInteger(freshness.skippedRows, 'support machine freshness.skippedRows');
  if (freshness.kind === 'unavailable') {
    assertExactKeys(
      freshness,
      ['kind', 'observedAt', 'omittedMachines', 'reason', 'skippedRows'],
      'support machine freshness',
    );
    if (!(freshness.reason === 'bootstrap-budget' || freshness.reason === 'not-captured')) {
      throw new Error('support machine freshness.reason is invalid');
    }
    return;
  }
  if (freshness.kind !== 'available') {
    throw new Error('support machine freshness.kind is invalid');
  }
  assertExactKeys(
    freshness,
    ['kind', 'machines', 'observedAt', 'omittedMachines', 'skippedRows'],
    'support machine freshness',
  );
  if (!Array.isArray(freshness.machines) || freshness.machines.length > 100) {
    throw new Error('support machine freshness.machines must be a bounded array');
  }
  const machineIds = new Set<string>();
  for (const [index, rawMachine] of freshness.machines.entries()) {
    const machine = requireRecord(rawMachine, `support machine freshness.machines[${index}]`);
    assertExactKeys(machine, ['id', 'label', 'lastSeenAt'], `support machine freshness.machines[${index}]`);
    const id = requireString(machine.id, `support machine freshness.machines[${index}].id`);
    const label = requireString(machine.label, `support machine freshness.machines[${index}].label`);
    requireIsoTimestamp(machine.lastSeenAt, `support machine freshness.machines[${index}].lastSeenAt`);
    if (id.length === 0 || label.length === 0 || machineIds.has(id)) {
      throw new Error('support machine freshness IDs and labels must be non-empty and IDs must be unique');
    }
    machineIds.add(id);
  }
};

export const parseFocusedReportSupport = (value: unknown): FocusedReportSupport => {
  const support = requireRecord(value, 'focused report support');
  if (Object.hasOwn(support, 'rows') || Object.hasOwn(support, 'tableRows')) {
    throw new Error('Focused report support must not contain report rows');
  }
  const { machineFreshness, ...usageReportSupport } = support;
  parseUsageReportPayload({ ...usageReportSupport, rows: [], tableRows: [] });
  if (machineFreshness !== undefined) {
    assertFocusedMachineFreshness(machineFreshness);
  }
  return support as unknown as FocusedReportSupport;
};

const assertBootstrapSupport = (value: unknown): void => {
  const support = requireRecord(value, 'bootstrap support');
  assertAllowedKeys(
    support,
    ['analytics', 'filters', 'generatedAt', 'omittedRows', 'timeZone'],
    ['datasets', 'warnings'],
    'bootstrap support',
  );
  assertAnalyticsSummary(support.analytics, 'bootstrap support.analytics');
  assertReportFilters(support.filters, 'bootstrap support.filters');
  requireIsoTimestamp(support.generatedAt, 'bootstrap support.generatedAt');
  requireNonNegativeSafeInteger(support.omittedRows, 'bootstrap support.omittedRows');
  if (!isReportTimeZone(support.timeZone)) {
    throw new Error('bootstrap support.timeZone is invalid');
  }
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
  kind: 'support',
  value: unknown,
  request: FocusedRevisionRequest,
): FocusedSupportResult;
export function parseFocusedReportQueryResult(
  kind: FocusedReportQueryKind,
  value: unknown,
  request: FocusedBreakdownRequest | FocusedOverviewRequest | FocusedRevisionRequest,
): FocusedReportQueryResult;
export function parseFocusedReportQueryResult(
  kind: FocusedReportQueryKind,
  value: unknown,
  request: FocusedBreakdownRequest | FocusedOverviewRequest | FocusedRevisionRequest,
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
    assertExactKeys(metadata, ['filters', 'generatedAt', 'omittedRows', 'timeZone'], 'overview metadata');
    assertReportFilters(metadata.filters, 'overview metadata.filters');
    requireIsoTimestamp(metadata.generatedAt, 'overview metadata.generatedAt');
    requireNonNegativeSafeInteger(metadata.omittedRows, 'overview metadata.omittedRows');
    if (!isReportTimeZone(metadata.timeZone)) {
      throw new Error('overview metadata.timeZone is invalid');
    }
    assertFocusedSummary(record.summary, 'overview summary');
    assertFocusedTimeline(record.timeline, parsed.timeline);
    assertOverviewView(record.view, parsed.includeAdvanced);
    return record as unknown as FocusedOverviewResult;
  }
  if (kind === 'breakdown') {
    const parsed = parseFocusedBreakdownRequest(request);
    const record = assertResultEnvelope(
      value,
      [
        'context',
        'groups',
        'requestFingerprint',
        'revision',
        ...(parsed.includeObservatory ? ['tokenFlow', 'constellation'] : []),
      ],
      parsed.query.revision,
      focusedBreakdownFingerprint(parsed),
    );
    if (parsed.includeObservatory) {
      parseTokenFlow(record.tokenFlow);
      parseConstellation(record.constellation);
    }
    assertBreakdownGroups(record.groups);
    assertBreakdownContext(record.context);
    return record as unknown as FocusedBreakdownResult;
  }
  const parsed = parseFocusedRevisionRequest(request);
  const record = assertResultEnvelope(
    value,
    [
      'dateDomain',
      'filterOptions',
      'machineFreshness',
      'providerRows',
      'requestFingerprint',
      'revision',
      'support',
      'truncation',
    ],
    parsed.revision,
    focusedRevisionFingerprint(kind, parsed),
  );
  assertFocusedDateDomain(record.dateDomain, 'support dateDomain');
  assertFocusedMachineFreshness(record.machineFreshness);
  const options = requireRecord(record.filterOptions, 'support filter options');
  assertExactKeys(options, ['harness', 'machine', 'truncated'], 'support filter options');
  if (
    !Array.isArray(options.harness) ||
    options.harness.length > 100 ||
    !Array.isArray(options.machine) ||
    options.machine.length > 100 ||
    options.harness.some((entry) => typeof entry !== 'string') ||
    typeof options.truncated !== 'boolean'
  ) {
    throw new Error('Support filter options are invalid');
  }
  const machineValues = new Set<string>();
  for (const [index, entry] of options.machine.entries()) {
    const option = requireRecord(entry, `support filter options.machine[${index}]`);
    assertExactKeys(option, ['label', 'value'], `support filter options.machine[${index}]`);
    const label = requireString(option.label, `support filter options.machine[${index}].label`);
    const optionValue = requireString(option.value, `support filter options.machine[${index}].value`);
    if (label === '' || optionValue === '' || machineValues.has(optionValue)) {
      throw new Error('Support machine filter options must have unique non-empty values and labels');
    }
    machineValues.add(optionValue);
  }
  if (!Array.isArray(record.providerRows) || record.providerRows.length > 100) {
    throw new Error('Support provider rows are invalid');
  }
  const providerRows = record.providerRows.map((row, index) =>
    parseSessionPresentationRow(row, `support providerRows[${index}]`),
  );
  assertBootstrapSupport(record.support);
  const parsedMachineFreshness = requireRecord(record.machineFreshness, 'support machine freshness');
  const parsedBootstrapSupport = requireRecord(record.support, 'bootstrap support');
  if (parsedMachineFreshness.observedAt !== parsedBootstrapSupport.generatedAt) {
    throw new Error('Support machine freshness must use the bootstrap generation timestamp');
  }
  assertSupportTruncation(record.truncation);
  return { ...record, providerRows } as unknown as FocusedSupportResult;
}
