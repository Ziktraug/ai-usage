import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { FocusedFilterOption } from '@ai-usage/report-core/focused-report-query';
import {
  buildSessionCampaignTotals,
  buildSortedSessionPresentationRows,
  type SessionCampaignTotals,
  type SessionOrigin,
  type SessionQueryFilters,
  sessionCampaignIdentityForRow,
  sessionModelKeys,
} from '@ai-usage/report-core/session-query';
import { DAY_MS, type DateBounds, rowMatchesDateBounds } from '../date-range';
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from '../presentation/format';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
  buildReportSummary,
  type DashboardRow,
  type ReportSummary,
} from '../presentation/report-value';
import { isSessionColumnId, type SessionColumnId, sortValueForSessionColumn } from '../session/session-table-schema';
import type { TableSortingState } from '../table/state';
import {
  buildAnalyticsGroups,
  buildHarnessProviderAnalyticsGroups,
  buildModelAnalyticsGroups,
  buildProjectGroups,
  type ProjectGroup,
} from './dashboard-analytics';
import type { Metric, MetricDelta } from './dashboard-metric-model';
import type { FieldFilterKey, FieldFilters } from './dashboard-search';

export const fieldValueForRow = (row: DashboardRow, key: FieldFilterKey) => {
  if (key === 'campaign') {
    return sessionCampaignIdentityForRow(row).campaignKey;
  }
  if (key === 'provider') {
    return row.providerDisplay;
  }
  if (key === 'model') {
    return row.modelKey;
  }
  return row.projectKey;
};

export const fieldValuesForRow = (row: DashboardRow, key: FieldFilterKey): readonly string[] =>
  key === 'model' ? sessionModelKeys(row) : [fieldValueForRow(row, key)];

export interface FilterSnapshot {
  fieldEntries: [FieldFilterKey, string][];
  harness: string[];
  machine: string[];
  origin: SessionOrigin[];
  query: string;
}

export const createFilterSnapshot = (
  query: string,
  harness: string[],
  machine: string[],
  filters: FieldFilters,
  origin: SessionOrigin[] = [],
): FilterSnapshot => ({
  fieldEntries: Object.entries(filters) as [FieldFilterKey, string][],
  harness,
  machine,
  origin,
  query: query.trim().toLowerCase(),
});

export const matchesFilterSnapshot = (row: DashboardRow, filters: FilterSnapshot) =>
  row.searchText.includes(filters.query) &&
  (filters.harness.length === 0 || filters.harness.includes(row.harness)) &&
  (filters.machine.length === 0 || filters.machine.includes(row.source?.machineId ?? '')) &&
  (filters.origin.length === 0 || row.origin === undefined || filters.origin.includes(row.origin)) &&
  filters.fieldEntries.every(([key, value]) => fieldValuesForRow(row, key).includes(value));

export const filterTimelineRows = (rows: DashboardRow[], filters: FilterSnapshot) =>
  rows.filter((row) => matchesFilterSnapshot(row, filters));

export const machineFilterOptionsForRows = (rows: readonly DashboardRow[]): FocusedFilterOption[] => {
  const options = new Map<string, FocusedFilterOption>();
  for (const row of rows) {
    const value = row.source?.machineId ?? '';
    if (value === '' || options.has(value)) {
      continue;
    }
    const machineLabel = row.source?.machineLabel ?? '';
    options.set(value, {
      label: machineLabel || 'Unknown machine',
      value,
    });
  }
  return [...options.values()];
};

export const filterRowsByDateBounds = (rows: DashboardRow[], bounds: DateBounds) =>
  rows.filter((row) => rowMatchesDateBounds(row, bounds));

export const buildSortedDashboardRows = (rows: DashboardRow[], sorting: TableSortingState) =>
  buildSortedSessionPresentationRows(rows, sorting);

export type CampaignKey = string;

export type CampaignTotals = SessionCampaignTotals;

export interface CampaignView {
  allChildren: DashboardRow[];
  allClassifiers: DashboardRow[];
  allRows: DashboardRow[];
  allTotals: CampaignTotals;
  campaignKey: CampaignKey;
  label: string;
  /** Members that satisfy the current query; the classifier rollup is excluded. */
  matchedRows: DashboardRow[];
  root: DashboardRow;
  rootSourceSessionId: string;
  totalCount: number;
  visibleChildren: DashboardRow[];
  visibleCount: number;
  visibleRows: DashboardRow[];
  visibleTotals: CampaignTotals;
}

export interface CampaignTableItem {
  campaign: CampaignView;
  children: DashboardRow[];
  kind: 'campaign';
  row: DashboardRow;
}

const campaignIdentityForRow = sessionCampaignIdentityForRow;

export const buildCampaignTotals = (rows: DashboardRow[], root?: DashboardRow): CampaignTotals =>
  buildSessionCampaignTotals(rows, root);

export const buildCampaignViews = (
  allRows: DashboardRow[],
  visibleRows: DashboardRow[],
  labelFor: (campaignKey: string, derivedLabel: string) => string = (_campaignKey, derivedLabel) => derivedLabel,
): CampaignView[] => {
  const visibleKeys = new Set(visibleRows.map(rowKeyForCampaignMembership));
  const groups = new Map<CampaignKey, DashboardRow[]>();

  for (const row of allRows) {
    const identity = campaignIdentityForRow(row);
    const rows = groups.get(identity.campaignKey) ?? [];
    rows.push(row);
    groups.set(identity.campaignKey, rows);
  }

  const campaigns: CampaignView[] = [];
  for (const [campaignKey, rows] of groups) {
    const firstIdentity = campaignIdentityForRow(rows[0]!);
    const root =
      rows.find(
        (row) =>
          row.source?.sourceSessionId === firstIdentity.rootSourceSessionId ||
          (!row.source?.sourceSessionId && row.rowId === firstIdentity.rootSourceSessionId),
      ) ?? (rows.some((row) => row.origin === 'classifier') ? undefined : rows[0]);
    if (!root) {
      throw new Error(`Classifier campaign ${campaignKey} has no resolvable parent session`);
    }

    const allChildren = rows.filter((row) => row !== root);
    const allClassifiers = rows.filter((row) => row.origin === 'classifier');
    const matchedRows = rows.filter((row) => visibleKeys.has(rowKeyForCampaignMembership(row)));
    if (!matchedRows.length) {
      continue;
    }
    const visibleKeysWithClassifierRollup = new Set(
      [...matchedRows, ...allClassifiers].map(rowKeyForCampaignMembership),
    );
    const visibleRowsForTotals = rows.filter((row) =>
      visibleKeysWithClassifierRollup.has(rowKeyForCampaignMembership(row)),
    );
    const visibleChildren = allChildren.filter((row) =>
      visibleKeysWithClassifierRollup.has(rowKeyForCampaignMembership(row)),
    );

    campaigns.push({
      campaignKey,
      label: labelFor(campaignKey, root.sessionLabel),
      matchedRows,
      rootSourceSessionId: firstIdentity.rootSourceSessionId,
      root,
      visibleRows: visibleRowsForTotals,
      allRows: rows,
      visibleChildren,
      allChildren,
      allClassifiers,
      visibleTotals: buildCampaignTotals(visibleRowsForTotals, root),
      allTotals: buildCampaignTotals(rows, root),
      visibleCount: matchedRows.length,
      totalCount: rows.length,
    });
  }

  return campaigns;
};

const rowKeyForCampaignMembership = (row: DashboardRow) => row.rowId;

const campaignSortValue = (campaign: CampaignView, columnId: SessionColumnId): number | string => {
  const totals = campaign.visibleTotals;
  const root = campaign.root;
  switch (columnId) {
    case 'date':
      return Math.max(...campaign.matchedRows.map((row) => row.sortDate));
    case 'tokIn':
      return totals.tokIn;
    case 'tokOut':
      return totals.tokOut;
    case 'cache':
      return totals.cacheRead;
    case 'tokCw':
      return totals.cacheWrite;
    case 'fresh':
      return totals.freshTokens;
    case 'total':
      return totals.tokenTotal;
    case 'rtkSaved':
      return totals.rtkInputTokens ? (totals.rtkSavedTokens / totals.rtkInputTokens) * 100 : 0;
    case 'cost':
      return totals.costKnown || totals.totalCost > 0 ? totals.totalCost : Number.NEGATIVE_INFINITY;
    case 'actual':
      return totals.actualCost;
    case 'quota':
      return totals.costQuota;
    case 'duration':
      return totals.durationMs ?? 0;
    case 'calls':
      return totals.calls;
    case 'turns':
      return totals.turns;
    case 'tools':
      return totals.tools;
    case 'lines':
      return totals.lineDelta ?? 0;
    case 'subagent':
      return campaign.visibleRows.some((row) => row.subagent) ? 1 : 0;
    case 'partial':
      return campaign.visibleRows.some((row) => row.partial) ? 1 : 0;
    case 'ambiguous':
      return campaign.visibleRows.some((row) => row.ambiguous) ? 1 : 0;
    case 'harness':
      return root.sortHarness;
    case 'machine':
      return root.sortMachine;
    case 'provider':
      return root.sortProvider;
    case 'model':
      return root.sortModel;
    case 'project':
      return root.sortProject;
    case 'session':
      return root.sortSession;
    default:
      return sortValueForSessionColumn(root, columnId);
  }
};

const itemSortValue = (item: CampaignTableItem, columnId: SessionColumnId): number | string =>
  item.kind === 'campaign' ? campaignSortValue(item.campaign, columnId) : sortValueForSessionColumn(item.row, columnId);

const compareCampaignSortValues = (av: number | string, bv: number | string) => {
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv));
  }
  if (av === bv) {
    return 0;
  }
  return av > bv ? 1 : -1;
};

const compareCampaignTableItems = (sorting: TableSortingState) => (a: CampaignTableItem, b: CampaignTableItem) => {
  for (const sort of sorting) {
    if (!isSessionColumnId(sort.id)) {
      continue;
    }
    const av = itemSortValue(a, sort.id);
    const bv = itemSortValue(b, sort.id);
    const result = compareCampaignSortValues(av, bv);
    if (result !== 0) {
      return sort.desc ? -result : result;
    }
  }
  return 0;
};

export const buildCampaignTableItems = (
  allRows: DashboardRow[],
  visibleRows: DashboardRow[],
  sorting: TableSortingState,
  preparedCampaigns?: CampaignView[],
): CampaignTableItem[] => {
  const campaigns = preparedCampaigns ?? buildCampaignViews(allRows, visibleRows);
  const campaignByKey = new Map(campaigns.map((campaign) => [campaign.campaignKey, campaign]));
  const emittedCampaigns = new Set<CampaignKey>();
  const items: CampaignTableItem[] = [];

  for (const row of visibleRows) {
    const identity = campaignIdentityForRow(row);
    const campaign = campaignByKey.get(identity.campaignKey);
    if (campaign) {
      if (emittedCampaigns.has(campaign.campaignKey)) {
        continue;
      }
      emittedCampaigns.add(campaign.campaignKey);
      items.push({ kind: 'campaign', row: campaign.root, campaign, children: campaign.visibleChildren });
    }
  }

  for (const campaign of campaigns) {
    if (emittedCampaigns.has(campaign.campaignKey)) {
      continue;
    }
    emittedCampaigns.add(campaign.campaignKey);
    items.push({ kind: 'campaign', row: campaign.root, campaign, children: campaign.visibleChildren });
  }

  return items.sort(compareCampaignTableItems(sorting));
};

const campaignDisplayRow = (campaign: CampaignView, sorting: TableSortingState): DashboardRow => {
  const totals = campaign.visibleTotals;
  const visibleChildren = buildSortedDashboardRows(campaign.visibleChildren, sorting);
  const latestVisibleRow = campaign.matchedRows.reduce(
    (latest, row) => (row.sortDate > latest.sortDate ? row : latest),
    campaign.matchedRows[0] ?? campaign.root,
  );
  const ambiguous = campaign.visibleRows.some((row) => row.ambiguous);
  const partial = campaign.visibleRows.some((row) => row.partial);
  const usageUnavailable = campaign.visibleRows.every((row) => row.usageUnavailable);
  return {
    ...campaign.root,
    activeDate: latestVisibleRow.activeDate,
    activeTime: latestVisibleRow.activeTime,
    ambiguous,
    campaignClassifierCount: campaign.allClassifiers.length,
    campaignClassifierFreshTokens: campaign.allClassifiers.reduce((sum, row) => sum + row.freshTokens, 0),
    campaignKey: campaign.campaignKey,
    campaignTotalCount: campaign.totalCount,
    campaignVisibleCount: campaign.visibleCount,
    calls: totals.calls,
    children: visibleChildren,
    costActual: totals.actualCost,
    costApprox: totals.totalCost,
    costKnown: totals.costKnown,
    costQuota: totals.costQuota,
    priceMeasurement: totals.priceMeasurement,
    durationMs: totals.durationMs,
    freshTokens: totals.freshTokens,
    lineDelta: totals.lineDelta,
    linesAdded: totals.linesAdded,
    linesDeleted: totals.linesDeleted,
    rtkInputTokens: totals.rtkInputTokens,
    rtkCommandCount: totals.rtkCommandCount,
    rtkOutputTokens: totals.rtkOutputTokens,
    rtkSavedTokens: totals.rtkSavedTokens,
    partial,
    sessionLabel: campaign.label,
    sortDate: latestVisibleRow.sortDate,
    tokenTotal: totals.tokenTotal,
    tokCr: totals.cacheRead,
    tokCw: totals.cacheWrite,
    tokIn: totals.tokIn,
    tokOut: totals.tokOut,
    tools: totals.tools,
    turns: totals.turns,
    usageUnavailable,
  };
};

export const buildCampaignTableRows = (
  allRows: DashboardRow[],
  visibleRows: DashboardRow[],
  sorting: TableSortingState,
  preparedCampaigns?: CampaignView[],
): DashboardRow[] =>
  buildCampaignTableItems(allRows, visibleRows, sorting, preparedCampaigns).map((item) =>
    campaignDisplayRow(item.campaign, sorting),
  );

export const buildVisibleSummary = (rows: DashboardRow[], bounds: DateBounds) =>
  buildReportSummary(rows, (row) => rowMatchesDateBounds(row, bounds));

/** A closed interval of instants; both ends belong to it. */
export interface PeriodWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The window of equal length that ends where the selected period starts. It mirrors the previous
 * period of the focused Overview projections (`previousPeriodSummary` in report-core and its SQLite
 * twin): an open selection ends at the report's generation instant and the span is at least one day.
 * A selection without a start has no previous window.
 */
export const previousPeriodWindow = (bounds: DateBounds, generatedAt: Date): PeriodWindow | null => {
  if (!bounds.from) {
    return null;
  }
  const from = bounds.from.getTime();
  const to = (bounds.to ?? generatedAt).getTime();
  const span = Math.max(DAY_MS, to - from);
  return { from: new Date(from - span), to: new Date(from - 1) };
};

export const buildPreviousPeriodBounds = (bounds: DateBounds, generatedAt: Date): DateBounds | null =>
  previousPeriodWindow(bounds, generatedAt);

export const buildPreviousPeriodSummary = (rows: DashboardRow[], bounds: DateBounds, generatedAt: Date) => {
  const previousBounds = buildPreviousPeriodBounds(bounds, generatedAt);
  if (!previousBounds) {
    return null;
  }
  const summary = buildVisibleSummary(rows, previousBounds);
  return summary.sessionCount > 0 ? summary : null;
};

/** The recorded history that decides whether a window was recorded at all. */
export interface PeriodRecordedHistory {
  /** Earliest recorded activity of this history. */
  readonly first: Date;
  /** The harnesses this history is limited to, as the harness filter names them; empty for every harness. */
  readonly limitedToHarnesses: readonly string[];
}

export interface PeriodRecordedHistoryInput {
  /** Earliest activity under every one of those filters except the period (the Overview's date domain). */
  readonly filteredFirst: string | null;
  /** The filters the summaries were queried under. */
  readonly filters: SessionQueryFilters;
  /** Earliest activity of the whole report revision under no filter (the bootstrap support's date domain). */
  readonly unfilteredFirst: string | null;
}

const filtersBeyondHarness = ({ fields, localTimeCell, machine, origin, query }: SessionQueryFilters): boolean =>
  query.trim() !== '' ||
  Object.values(fields).some((value) => value !== undefined && value.trim() !== '') ||
  machine.length > 0 ||
  (origin?.length ?? 0) > 0 ||
  localTimeCell !== undefined;

/**
 * Chooses the history that tells an unrecorded window from one where nothing matched. Recording is
 * per harness, so the first session of one harness is where its history starts. Any other filter
 * only selects among recorded sessions: its first match says nothing about what was recorded, so the
 * history of every harness decides. Under a harness filter combined with another filter, the start
 * of the harness history alone is not observable, and the history of every harness decides too.
 */
export const periodRecordedHistory = ({
  filteredFirst,
  filters,
  unfilteredFirst,
}: PeriodRecordedHistoryInput): PeriodRecordedHistory | null => {
  const harnessHistory = filters.harness.length > 0 && !filtersBeyondHarness(filters);
  const first = harnessHistory ? filteredFirst : unfilteredFirst;
  if (first === null) {
    return null;
  }
  return { first: new Date(first), limitedToHarnesses: harnessHistory ? filters.harness : [] };
};

/**
 * Why the previous window cannot serve as a baseline. Each reason is its own outcome so that no
 * caller can turn a missing baseline into a zero or a percentage.
 */
export type PeriodBaselineAbsence =
  /** The selection has no start, so no window of equal length precedes it. */
  | { readonly kind: 'full-range' }
  /**
   * The deciding recorded history starts after the previous window does. The window is
   * `unrecorded` when history starts inside the selected period, `partly-recorded` when it starts
   * inside the previous window: what it holds then covers only part of the window.
   */
  | {
      readonly history: PeriodRecordedHistory;
      readonly kind: 'history-shorter-than-window';
      readonly previousPeriod: 'partly-recorded' | 'unrecorded';
      readonly window: PeriodWindow;
    }
  /** History covers the previous window and no session matched the current filters in it. */
  | { readonly kind: 'no-previous-sessions'; readonly window: PeriodWindow };

export type PeriodBaseline<Summary> =
  | { readonly kind: 'available'; readonly previous: Summary; readonly window: PeriodWindow }
  | PeriodBaselineAbsence;

export interface PeriodBaselineInput<Summary> {
  /** The selected period, exactly as the summaries were queried. */
  readonly bounds: DateBounds;
  readonly generatedAt: Date;
  /** The same aggregation over the previous window under the same filters; null when it holds no session. */
  readonly previousSummary: Summary | null;
  /** The history that decides what was recorded (`periodRecordedHistory`); null when nothing is recorded. */
  readonly recordedHistory: PeriodRecordedHistory | null;
}

/**
 * Decides whether the previous window is a like-for-like baseline. A window that recorded history
 * does not cover from its first instant is never one: activity that was not recorded cannot be told
 * from activity that did not happen.
 */
export const resolvePeriodBaseline = <Summary>({
  bounds,
  generatedAt,
  previousSummary,
  recordedHistory,
}: PeriodBaselineInput<Summary>): PeriodBaseline<Summary> => {
  const window = previousPeriodWindow(bounds, generatedAt);
  if (window === null || bounds.from === null) {
    return { kind: 'full-range' };
  }
  if (recordedHistory !== null && recordedHistory.first.getTime() > window.from.getTime()) {
    return {
      history: recordedHistory,
      kind: 'history-shorter-than-window',
      previousPeriod: recordedHistory.first.getTime() >= bounds.from.getTime() ? 'unrecorded' : 'partly-recorded',
      window,
    };
  }
  return previousSummary === null
    ? { kind: 'no-previous-sessions', window }
    : { kind: 'available', previous: previousSummary, window };
};

/** One metric read from one period's summary. */
export interface PeriodMetricReading {
  /** False when the value only bounds the metric from below, such as an API value with unpriced usage. */
  readonly complete: boolean;
  readonly value: number;
}

/**
 * The outcome of comparing one metric with the previous window. Only `change` carries a percentage;
 * the limits are per metric, so one metric can lack a percentage while another keeps its own.
 */
export type MetricPeriodComparison =
  | {
      readonly current: number;
      readonly kind: 'change';
      /** Signed change against the previous window, in percent of its value. */
      readonly percent: number;
      readonly previous: number;
      /** The selected period has not ended, so its side of the comparison can still grow. */
      readonly provisional: boolean;
      readonly window: PeriodWindow;
    }
  /** The previous window measured nothing for this metric: a percentage of zero does not exist. */
  | { readonly kind: 'zero-baseline'; readonly window: PeriodWindow }
  /** At least one period only bounds this metric from below, which cannot anchor a percentage. */
  | {
      readonly current: PeriodMetricReading;
      readonly kind: 'partial-measurement';
      readonly previous: PeriodMetricReading;
      readonly window: PeriodWindow;
    }
  | PeriodBaselineAbsence;

/** Compares one metric across both periods by applying the same reading to both summaries. */
export const comparePeriodMetric = <Summary>(
  baseline: PeriodBaseline<Summary>,
  currentSummary: Summary,
  read: (summary: Summary) => PeriodMetricReading,
  periodInProgress: boolean,
): MetricPeriodComparison => {
  if (baseline.kind !== 'available') {
    return baseline;
  }
  const { window } = baseline;
  const current = read(currentSummary);
  const previous = read(baseline.previous);
  if (!(current.complete && previous.complete)) {
    return { current, kind: 'partial-measurement', previous, window };
  }
  if (previous.value <= 0) {
    return { kind: 'zero-baseline', window };
  }
  return {
    current: current.value,
    kind: 'change',
    percent: ((current.value - previous.value) / previous.value) * 100,
    previous: previous.value,
    provisional: periodInProgress,
    window,
  };
};

/** Estimated API-equivalent value; a lower bound as soon as part of the usage is unpriced. */
export const totalApiValueReading = (
  summary: Pick<ReportSummary, 'priceMeasurement' | 'totalCost'>,
): PeriodMetricReading => ({
  complete: summary.priceMeasurement.state !== 'partially measured',
  value: summary.totalCost,
});

/** Processed tokens: cache read, cache write, input and output. */
export const processedTokensReading = (
  summary: Pick<ReportSummary, 'cacheRead' | 'cacheWrite' | 'tokIn' | 'tokOut'>,
): PeriodMetricReading => ({
  complete: true,
  value: summary.cacheRead + summary.cacheWrite + summary.tokIn + summary.tokOut,
});

export const hiddenSessionCount = (totalRows: number, visibleRows: number) => totalRows - visibleRows;

export const buildModelGroups = (rows: DashboardRow[], bounds: DateBounds, _totalCost: number): AnalyticsGroup[] =>
  buildModelAnalyticsGroups(rows, (row) => rowMatchesDateBounds(row, bounds));

export const buildProviderGroups = (rows: DashboardRow[], bounds: DateBounds, totalCost: number): AnalyticsGroup[] =>
  buildAnalyticsGroups(
    rows,
    (row) => rowMatchesDateBounds(row, bounds),
    (row) => row.providerDisplay,
    totalCost,
  );

export const buildHarnessProviderGroups = (
  rows: DashboardRow[],
  bounds: DateBounds,
  totalCost: number,
): AnalyticsGroup[] => buildHarnessProviderAnalyticsGroups(rows, (row) => rowMatchesDateBounds(row, bounds), totalCost);

export const buildHarnessGroups = (rows: DashboardRow[], bounds: DateBounds, totalCost: number): AnalyticsGroup[] =>
  buildAnalyticsGroups(
    rows,
    (row) => rowMatchesDateBounds(row, bounds),
    (row) => row.harness,
    totalCost,
  );

export const buildProjectGroupRows = (rows: DashboardRow[], bounds: DateBounds): ProjectGroup[] =>
  buildProjectGroups(rows, (row) => rowMatchesDateBounds(row, bounds));

export const deltaVs = (
  current: number,
  previous: number | undefined,
  fmt: (value: number) => string,
): MetricDelta | null => {
  if (previous == null || previous <= 0) {
    return null;
  }
  return {
    pct: ((current - previous) / previous) * 100,
    hint: `Previous period of equal length: ${fmt(previous)}`,
  };
};

export const buildDashboardMetrics = (summary: ReportSummary, previous?: ReportSummary | null): Metric[] => {
  const prev = previous ?? undefined;
  const apiValue = aggregateApiValuePresentation(summary.priceMeasurement);
  const apiValueProvenance = aggregateApiPriceProvenance(summary.priceMeasurement);
  const metrics: Metric[] = [
    {
      kind: 'sessions',
      label: 'Sessions',
      value: fmtNum(summary.sessionCount),
      hint: 'Sessions in the current filter',
      delta: deltaVs(summary.sessionCount, prev?.sessionCount, fmtNum),
    },
    {
      kind: 'api-value',
      label: apiValueProvenance ? `API value · ${apiValueProvenance.label}` : 'API value',
      value: apiValue.label,
      hint: [
        `Estimated API-equivalent value at standard prices for ${fmtNum(summary.pricedSessions)} of ${fmtNum(summary.sessionCount)} fully priced sessions, including usage covered by subscriptions`,
        apiValueProvenance?.description,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      delta: deltaVs(summary.totalCost, prev?.totalCost, fmtMoney),
    },
    {
      kind: 'actual-cost',
      label: 'Charged amount',
      value: fmtMoney(summary.actualCost),
      hint: `Amount reported as charged by collectors; sessions without a reported amount fall back to the API-equivalent estimate${
        summary.unknownActual ? ` (${fmtNum(summary.unknownActual)} sessions unknown)` : ''
      }`,
      delta: deltaVs(summary.actualCost, prev?.actualCost, fmtMoney),
    },
  ];

  metrics.push({
    kind: 'subscription-value',
    label: 'Subscription value',
    value: fmtMoney(summary.costQuota),
    hint: 'Cursor export value covered by the subscription quota',
    delta: deltaVs(summary.costQuota, prev?.costQuota, fmtMoney),
  });

  metrics.push(
    {
      kind: 'mean-cost',
      label: 'Mean / sess',
      value: fmtMoney(summary.meanCost),
      hint: 'Mean API value per priced session',
    },
    {
      kind: 'fresh-tokens',
      label: 'Fresh tokens',
      value: fmtCompact(summary.fresh),
      hint: `Tokens processed without cache: ${fmtNum(summary.fresh)}`,
      delta: deltaVs(summary.fresh, prev?.fresh, fmtCompact),
    },
  );

  if (summary.rtkSaved) {
    metrics.push({
      kind: 'rtk-savings',
      label: 'RTK token savings',
      value: fmtPct(summary.rtkInput ? (summary.rtkSaved / summary.rtkInput) * 100 : 0),
      hint: [
        `${fmtNum(summary.rtkSaved)} tokens saved in matched sessions`,
        `${fmtNum(summary.rtkInput)} RTK input tokens before filtering`,
        `${fmtNum(summary.rtkOutput)} RTK output tokens after filtering`,
      ].join('\n'),
    });
  }

  metrics.push(
    {
      kind: 'turns',
      label: 'Turns',
      value: fmtNum(summary.turns),
      hint: 'Assistant turns across the filtered sessions',
      delta: deltaVs(summary.turns, prev?.turns, fmtNum),
    },
    {
      kind: 'tool-calls',
      label: 'Tool calls',
      value: fmtNum(summary.tools),
      hint: 'Tool invocations across the filtered sessions',
      delta: deltaVs(summary.tools, prev?.tools, fmtNum),
    },
  );

  return metrics;
};
