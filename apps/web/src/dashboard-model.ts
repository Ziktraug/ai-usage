import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { FocusedFilterOption } from '@ai-usage/report-core/focused-report-query';
import {
  buildSessionCampaignTotals,
  buildSortedSessionPresentationRows,
  type SessionCampaignTotals,
  type SessionOrigin,
  sessionCampaignIdentityForRow,
  sessionModelKeys,
} from '@ai-usage/report-core/session-query';
import type { SortingState } from '@tanstack/solid-table';
import {
  buildAnalyticsGroups,
  buildModelAnalyticsGroups,
  buildProjectGroups,
  type ProjectGroup,
} from './dashboard-analytics';
import type { Metric, MetricDelta } from './dashboard-metrics';
import type { FieldFilterKey, FieldFilters } from './dashboard-search';
import { DAY_MS, type DateBounds, endOfDay, rowMatchesDateBounds } from './date-range';
import { isSessionColumnId, type SessionColumnId, sortValueForSessionColumn } from './session-table-schema';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
  buildReportSummary,
  type DashboardRow,
  fmtCompact,
  fmtMoney,
  fmtNum,
  fmtPct,
  type ReportSummary,
} from './shared';

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

export const buildSortedDashboardRows = (rows: DashboardRow[], sorting: SortingState) =>
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
      return Math.max(...campaign.visibleRows.map((row) => row.sortDate), root.sortDate);
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

const compareCampaignTableItems = (sorting: SortingState) => (a: CampaignTableItem, b: CampaignTableItem) => {
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
  sorting: SortingState,
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

const campaignDisplayRow = (campaign: CampaignView, sorting: SortingState): DashboardRow => {
  const totals = campaign.visibleTotals;
  const visibleChildren = buildSortedDashboardRows(campaign.visibleChildren, sorting);
  const latestVisibleRow = campaign.visibleRows.reduce(
    (latest, row) => (row.sortDate > latest.sortDate ? row : latest),
    campaign.visibleRows[0] ?? campaign.root,
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

export const campaignBadgeLabelForRow = (row: DashboardRow) => {
  if (!row.campaignKey || row.campaignTotalCount == null || row.campaignVisibleCount == null) {
    return null;
  }
  return `Campaign · ${row.campaignVisibleCount} ${row.campaignVisibleCount === 1 ? 'session' : 'sessions'}`;
};

export const buildCampaignTableRows = (
  allRows: DashboardRow[],
  visibleRows: DashboardRow[],
  sorting: SortingState,
  preparedCampaigns?: CampaignView[],
): DashboardRow[] =>
  buildCampaignTableItems(allRows, visibleRows, sorting, preparedCampaigns).map((item) =>
    campaignDisplayRow(item.campaign, sorting),
  );

export const buildVisibleSummary = (rows: DashboardRow[], bounds: DateBounds) =>
  buildReportSummary(rows, (row) => rowMatchesDateBounds(row, bounds));

export const buildPreviousPeriodBounds = (bounds: DateBounds, generatedAt: Date): DateBounds | null => {
  if (!bounds.from) {
    return null;
  }
  const from = bounds.from.getTime();
  const to = (bounds.to ?? endOfDay(generatedAt)).getTime();
  const span = Math.max(DAY_MS, to - from);
  return { from: new Date(from - span), to: new Date(from - 1) };
};

export const buildPreviousPeriodSummary = (rows: DashboardRow[], bounds: DateBounds, generatedAt: Date) => {
  const previousBounds = buildPreviousPeriodBounds(bounds, generatedAt);
  if (!previousBounds) {
    return null;
  }
  const summary = buildVisibleSummary(rows, previousBounds);
  return summary.sessionCount > 0 ? summary : null;
};

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
      label: 'Sessions',
      value: fmtNum(summary.sessionCount),
      hint: 'Sessions in the current filter',
      delta: deltaVs(summary.sessionCount, prev?.sessionCount, fmtNum),
    },
    {
      label: apiValueProvenance ? `API value · ${apiValueProvenance.label}` : 'API value',
      value: apiValue.label,
      hint: [
        `Estimated cost at standard API prices for ${fmtNum(summary.pricedSessions)} of ${fmtNum(summary.sessionCount)} fully priced sessions, including usage covered by subscriptions`,
        apiValueProvenance?.description,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      delta: deltaVs(summary.totalCost, prev?.totalCost, fmtMoney),
    },
    {
      label: 'Actual cost',
      value: fmtMoney(summary.actualCost),
      hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
        summary.unknownActual ? ` (${fmtNum(summary.unknownActual)} sessions unknown)` : ''
      }`,
      delta: deltaVs(summary.actualCost, prev?.actualCost, fmtMoney),
    },
  ];

  metrics.push({
    label: 'Sub value',
    value: fmtMoney(summary.costQuota),
    hint: 'Cursor export value covered by the subscription quota',
    delta: deltaVs(summary.costQuota, prev?.costQuota, fmtMoney),
  });

  metrics.push(
    { label: 'Mean / sess', value: fmtMoney(summary.meanCost), hint: 'Mean API value per priced session' },
    {
      label: 'Fresh tokens',
      value: fmtCompact(summary.fresh),
      hint: `Tokens processed without cache: ${fmtNum(summary.fresh)}`,
      delta: deltaVs(summary.fresh, prev?.fresh, fmtCompact),
    },
  );

  if (summary.rtkSaved) {
    metrics.push({
      label: 'RTK savings',
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
      label: 'Turns',
      value: fmtNum(summary.turns),
      hint: 'Assistant turns across the filtered sessions',
      delta: deltaVs(summary.turns, prev?.turns, fmtNum),
    },
    {
      label: 'Tool calls',
      value: fmtNum(summary.tools),
      hint: 'Tool invocations across the filtered sessions',
      delta: deltaVs(summary.tools, prev?.tools, fmtNum),
    },
  );

  return metrics;
};
