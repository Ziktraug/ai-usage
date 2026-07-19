import type { SessionPageItem } from '@ai-usage/report-core/session-query';
import type { CampaignView } from './dashboard-model';
import type { DashboardRow } from './shared';

export type SessionAnalysisTarget =
  | {
      kind: 'session';
      reportRowId: string;
      summaryRow: DashboardRow;
    }
  | {
      campaignKey: string;
      kind: 'campaign-root';
      reportRowId: string;
      summaryRow: DashboardRow;
      totalCount: number;
      visibleCount: number;
    };

export const sessionAnalysisTargetForSession = (row: DashboardRow): SessionAnalysisTarget => ({
  kind: 'session',
  reportRowId: row.rowId,
  summaryRow: row,
});

export const sessionAnalysisTargetForCampaign = (
  summaryRow: DashboardRow,
  campaign: CampaignView,
): SessionAnalysisTarget => ({
  campaignKey: campaign.campaignKey,
  kind: 'campaign-root',
  reportRowId: campaign.root.rowId,
  summaryRow,
  totalCount: campaign.totalCount,
  visibleCount: campaign.visibleCount,
});

export const sessionAnalysisTargetForPageItem = (item: SessionPageItem): SessionAnalysisTarget => {
  if (item.kind === 'session') {
    return sessionAnalysisTargetForSession(item.row);
  }
  const { campaignTotalCount, campaignVisibleCount } = item.row;
  if (campaignTotalCount === undefined || campaignVisibleCount === undefined) {
    throw new Error('Served campaign rows must include visible and total counts');
  }
  return {
    campaignKey: item.campaignKey,
    kind: 'campaign-root',
    reportRowId: item.row.rowId,
    summaryRow: item.row,
    totalCount: campaignTotalCount,
    visibleCount: campaignVisibleCount,
  };
};

export const sessionAnalysisTargetForTopLevelRow = (input: {
  campaigns: readonly CampaignView[];
  pageItems: readonly SessionPageItem[];
  row: DashboardRow;
}): SessionAnalysisTarget => {
  const pageItem = input.pageItems.find((item) => item.row.rowId === input.row.rowId);
  if (pageItem) {
    return sessionAnalysisTargetForPageItem(pageItem);
  }
  const campaign = input.campaigns.find((candidate) => candidate.root.rowId === input.row.rowId);
  return campaign ? sessionAnalysisTargetForCampaign(input.row, campaign) : sessionAnalysisTargetForSession(input.row);
};
