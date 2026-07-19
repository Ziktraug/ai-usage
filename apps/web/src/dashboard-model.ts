import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import {
  buildSessionCampaignTotals,
  buildSortedSessionPresentationRows,
  type SessionCampaignTotals,
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
  buildReportSummary,
  type DashboardRow,
  fmtCompact,
  fmtMoney,
  fmtNum,
  fmtPct,
  type ReportSummary,
} from './shared';

export const fieldValueForRow = (row: DashboardRow, key: FieldFilterKey) => {
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
  query: string;
}

export const createFilterSnapshot = (
  query: string,
  harness: string[],
  machine: string[],
  filters: FieldFilters,
): FilterSnapshot => ({
  fieldEntries: Object.entries(filters) as [FieldFilterKey, string][],
  harness,
  machine,
  query: query.trim().toLowerCase(),
});

export const matchesFilterSnapshot = (row: DashboardRow, filters: FilterSnapshot) =>
  row.searchText.includes(filters.query) &&
  (filters.harness.length === 0 || filters.harness.includes(row.harness)) &&
  (filters.machine.length === 0 || filters.machine.includes(row.source?.machineLabel ?? '')) &&
  filters.fieldEntries.every(([key, value]) => fieldValuesForRow(row, key).includes(value));

export const filterTimelineRows = (rows: DashboardRow[], filters: FilterSnapshot) =>
  rows.filter((row) => matchesFilterSnapshot(row, filters));

export const filterRowsByDateBounds = (rows: DashboardRow[], bounds: DateBounds) =>
  rows.filter((row) => rowMatchesDateBounds(row, bounds));

export const buildSortedDashboardRows = (rows: DashboardRow[], sorting: SortingState) =>
  buildSortedSessionPresentationRows(rows, sorting);

export type CampaignKey = string;

export type CampaignTotals = SessionCampaignTotals;

export interface CampaignView {
  allChildren: DashboardRow[];
  allRows: DashboardRow[];
  allTotals: CampaignTotals;
  campaignKey: CampaignKey;
  root: DashboardRow;
  rootSourceSessionId: string;
  totalCount: number;
  visibleChildren: DashboardRow[];
  visibleCount: number;
  visibleRows: DashboardRow[];
  visibleTotals: CampaignTotals;
}

export type CampaignTableItem =
  | { kind: 'session'; row: DashboardRow }
  | { kind: 'campaign'; row: DashboardRow; campaign: CampaignView; children: DashboardRow[] };

const campaignKeyFor = (row: DashboardRow, rootSourceSessionId: string): CampaignKey =>
  [row.source?.machineId ?? 'local', row.source?.harnessKey ?? row.harness, rootSourceSessionId].join(':');

const campaignIdentityForRow = (row: DashboardRow) => {
  const sourceSessionId = row.source?.sourceSessionId ?? null;
  const rootSourceSessionId = row.source?.rootSourceSessionId ?? null;
  if (!(sourceSessionId && rootSourceSessionId)) {
    return null;
  }
  return { campaignKey: campaignKeyFor(row, rootSourceSessionId), rootSourceSessionId, sourceSessionId };
};

export const buildCampaignTotals = (rows: DashboardRow[], root?: DashboardRow): CampaignTotals =>
  buildSessionCampaignTotals(rows, root);

export const buildCampaignViews = (allRows: DashboardRow[], visibleRows: DashboardRow[]): CampaignView[] => {
  const visibleKeys = new Set(visibleRows.map(rowKeyForCampaignMembership));
  const groups = new Map<CampaignKey, DashboardRow[]>();

  for (const row of allRows) {
    const identity = campaignIdentityForRow(row);
    if (!identity) {
      continue;
    }
    const rows = groups.get(identity.campaignKey) ?? [];
    rows.push(row);
    groups.set(identity.campaignKey, rows);
  }

  const campaigns: CampaignView[] = [];
  for (const [campaignKey, rows] of groups) {
    const firstIdentity = campaignIdentityForRow(rows[0]!);
    if (!firstIdentity) {
      continue;
    }
    const root = rows.find((row) => row.source?.sourceSessionId === firstIdentity.rootSourceSessionId);
    if (!root) {
      continue;
    }

    const allChildren = rows.filter((row) => row !== root);
    const hasDirectChildren = rows.some(
      (row) => row.source?.parentSourceSessionId === firstIdentity.rootSourceSessionId,
    );
    if (rows.length < 2 && !hasDirectChildren) {
      continue;
    }

    const rootMatches = visibleKeys.has(rowKeyForCampaignMembership(root));
    const visibleChildren = allChildren.filter((row) => visibleKeys.has(rowKeyForCampaignMembership(row)));
    const visibleRowsForTotals = [rootMatches ? root : null, ...visibleChildren].filter((row): row is DashboardRow =>
      Boolean(row),
    );
    if (!visibleRowsForTotals.length) {
      continue;
    }

    campaigns.push({
      campaignKey,
      rootSourceSessionId: firstIdentity.rootSourceSessionId,
      root,
      visibleRows: visibleRowsForTotals,
      allRows: rows,
      visibleChildren,
      allChildren,
      visibleTotals: buildCampaignTotals(visibleRowsForTotals, root),
      allTotals: buildCampaignTotals(rows, root),
      visibleCount: visibleRowsForTotals.length,
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
  groupCampaigns: boolean,
  preparedCampaigns?: CampaignView[],
): CampaignTableItem[] => {
  if (!groupCampaigns) {
    return buildSortedDashboardRows(visibleRows, sorting).map((row) => ({ kind: 'session', row }));
  }

  const campaigns = preparedCampaigns ?? buildCampaignViews(allRows, visibleRows);
  const campaignByKey = new Map(campaigns.map((campaign) => [campaign.campaignKey, campaign]));
  const childKeys = new Set(campaigns.flatMap((campaign) => campaign.allChildren.map(rowKeyForCampaignMembership)));
  const emittedCampaigns = new Set<CampaignKey>();
  const items: CampaignTableItem[] = [];

  for (const row of visibleRows) {
    const identity = campaignIdentityForRow(row);
    const campaign = identity ? campaignByKey.get(identity.campaignKey) : undefined;
    if (campaign) {
      if (emittedCampaigns.has(campaign.campaignKey)) {
        continue;
      }
      emittedCampaigns.add(campaign.campaignKey);
      items.push({ kind: 'campaign', row: campaign.root, campaign, children: campaign.visibleChildren });
      continue;
    }
    if (!childKeys.has(rowKeyForCampaignMembership(row))) {
      items.push({ kind: 'session', row });
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
    campaignKey: campaign.campaignKey,
    campaignTotalCount: campaign.totalCount,
    campaignVisibleCount: campaign.visibleCount,
    calls: totals.calls,
    children: visibleChildren,
    costActual: totals.actualCost,
    costApprox: totals.totalCost,
    costKnown: totals.costKnown,
    costQuota: totals.costQuota,
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
    sessionLabel: campaign.root.sessionLabel,
    sortDate: latestVisibleRow.sortDate,
    subagent: true,
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
  return row.campaignVisibleCount === row.campaignTotalCount
    ? `Campaign · ${row.campaignTotalCount} sessions`
    : `Campaign · ${row.campaignVisibleCount}/${row.campaignTotalCount} sessions`;
};

export const buildCampaignTableRows = (
  allRows: DashboardRow[],
  visibleRows: DashboardRow[],
  sorting: SortingState,
  groupCampaigns: boolean,
  preparedCampaigns?: CampaignView[],
): DashboardRow[] =>
  buildCampaignTableItems(allRows, visibleRows, sorting, groupCampaigns, preparedCampaigns).map((item) =>
    item.kind === 'campaign' ? campaignDisplayRow(item.campaign, sorting) : item.row,
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
  const metrics: Metric[] = [
    {
      label: 'Sessions',
      value: fmtNum(summary.sessionCount),
      hint: 'Sessions in the current filter',
      delta: deltaVs(summary.sessionCount, prev?.sessionCount, fmtNum),
    },
    {
      label: 'API value',
      value: fmtMoney(summary.totalCost),
      hint: `Estimated cost at standard API prices for ${fmtNum(summary.pricedSessions)} of ${fmtNum(summary.sessionCount)} fully priced sessions, including usage covered by subscriptions`,
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

  if (summary.costQuota) {
    metrics.push({
      label: 'Sub value',
      value: fmtMoney(summary.costQuota),
      hint: 'Cursor export value covered by the subscription quota',
      delta: deltaVs(summary.costQuota, prev?.costQuota, fmtMoney),
    });
  }

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
