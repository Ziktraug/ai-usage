import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { SessionWindowView } from '../../../query/options/session-window';

export interface CampaignSessionControlItem {
  readonly hidden: boolean;
  readonly row: SessionPresentationRow;
}

export interface CampaignSessionCollection {
  readonly items: readonly SessionPresentationRow[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface CampaignSessionControlsModel {
  readonly allSessionsLoaded: boolean;
  readonly campaignKey: string;
  readonly canClearCampaignFilter: boolean;
  readonly canLoadMore: boolean;
  readonly hiddenCount: number;
  readonly loadedCount: number;
  readonly loading: boolean;
  readonly rolledUpClassifierCount: number;
  readonly sessions: readonly CampaignSessionControlItem[];
  readonly totalCount: number;
  readonly visibleCount: number;
}

export interface CampaignSessionControlsInput {
  readonly campaign: SessionPresentationRow;
  readonly collection: CampaignSessionCollection;
  readonly query: SessionQueryRequest;
  readonly rolledUpClassifierCount?: number;
  readonly showAll: boolean;
  readonly visibleRows: readonly SessionPresentationRow[];
}

const uniqueRows = (rows: readonly SessionPresentationRow[]): SessionPresentationRow[] => {
  const seen = new Set<string>();
  const unique: SessionPresentationRow[] = [];
  for (const row of rows) {
    if (seen.has(row.rowId)) {
      continue;
    }
    seen.add(row.rowId);
    unique.push(row);
  }
  return unique;
};

export interface CampaignSessionControlsState {
  readonly collection: CampaignSessionCollection;
  readonly rolledUpClassifierCount: number;
  readonly visibleRows: readonly SessionPresentationRow[];
}

export const campaignSessionControlsState = (
  state: SessionWindowView | undefined,
  campaign: SessionPresentationRow,
): CampaignSessionControlsState | null => {
  const campaignKey = campaign.campaignKey;
  if (!campaignKey) {
    return null;
  }
  const allPage = state?.campaignSessions.get(campaignKey);
  if (!allPage?.root) {
    return null;
  }
  const filteredPage = state?.campaignChildren.get(campaignKey);
  const rootIsVisible = (campaign.campaignVisibleCount ?? 0) > (filteredPage?.sessionCount ?? 0);
  // The served projection returns every matching child plus classifier rows needed for
  // campaign totals. Its item/session count delta is therefore the exact number included
  // only by that rollup rule, without reimplementing the active filter in the browser.
  const rolledUpClassifierCount = Math.max(0, (filteredPage?.totalCount ?? 0) - (filteredPage?.sessionCount ?? 0));
  return {
    collection: {
      items: uniqueRows([allPage.root, ...allPage.items]),
      loading: allPage.loading,
      nextCursor: allPage.nextCursor,
      totalCount: allPage.totalCount + 1,
    },
    rolledUpClassifierCount,
    visibleRows: uniqueRows([...(rootIsVisible ? [allPage.root] : []), ...(filteredPage?.items ?? [])]),
  };
};

export const campaignSessionControlsModel = (
  input: CampaignSessionControlsInput,
): CampaignSessionControlsModel | null => {
  const campaignKey = input.campaign.campaignKey;
  if (!campaignKey) {
    return null;
  }

  const campaignRows = uniqueRows(input.collection.items);
  const visibleRowIds = new Set(input.visibleRows.map((row) => row.rowId));
  const visibleSessions: CampaignSessionControlItem[] = [];
  const hiddenSessions: CampaignSessionControlItem[] = [];
  for (const row of campaignRows) {
    if (visibleRowIds.has(row.rowId)) {
      visibleSessions.push({ hidden: false, row });
    } else {
      hiddenSessions.push({ hidden: true, row });
    }
  }

  const visibleCount = input.campaign.campaignVisibleCount ?? visibleSessions.length;
  const totalCount = input.collection.totalCount;
  const rolledUpClassifierCount = input.rolledUpClassifierCount ?? 0;
  return {
    allSessionsLoaded: input.collection.nextCursor === null,
    campaignKey,
    canClearCampaignFilter: input.query.filters.fields.campaign === campaignKey,
    canLoadMore: input.collection.nextCursor !== null,
    hiddenCount: Math.max(0, totalCount - visibleCount - rolledUpClassifierCount),
    loadedCount: campaignRows.length,
    loading: input.collection.loading,
    rolledUpClassifierCount,
    sessions: input.showAll ? [...visibleSessions, ...hiddenSessions] : visibleSessions,
    totalCount,
    visibleCount,
  };
};
