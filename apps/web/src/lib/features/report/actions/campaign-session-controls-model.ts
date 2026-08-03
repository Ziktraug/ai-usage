import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';

export interface CampaignSessionControlItem {
  readonly hidden: boolean;
  readonly row: SessionPresentationRow;
}

export interface CampaignSessionCollection {
  readonly items: readonly SessionPresentationRow[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
}

export interface CampaignSessionControlsModel {
  readonly allSessionsLoaded: boolean;
  readonly campaignKey: string;
  readonly canClearCampaignFilter: boolean;
  readonly canLoadMore: boolean;
  readonly hiddenCount: number;
  readonly loadedCount: number;
  readonly loading: boolean;
  readonly sessions: readonly CampaignSessionControlItem[];
  readonly totalCount: number;
  readonly visibleCount: number;
}

export interface CampaignSessionControlsInput {
  readonly campaign: SessionPresentationRow;
  readonly collection: CampaignSessionCollection;
  readonly query: SessionQueryRequest;
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
  const totalCount = input.campaign.campaignTotalCount ?? campaignRows.length;
  return {
    allSessionsLoaded: input.collection.nextCursor === null,
    campaignKey,
    canClearCampaignFilter: input.query.filters.fields.campaign === campaignKey,
    canLoadMore: input.collection.nextCursor !== null,
    hiddenCount: Math.max(0, totalCount - visibleCount),
    loadedCount: campaignRows.length,
    loading: input.collection.loading,
    sessions: input.showAll ? [...visibleSessions, ...hiddenSessions] : visibleSessions,
    totalCount,
    visibleCount,
  };
};
