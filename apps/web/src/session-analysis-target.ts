import type { SessionPageItem } from '@ai-usage/report-core/session-query';
import type { CampaignView } from './dashboard-model';
import type { DashboardRow } from './lib/foundation/presentation/report-value';

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

/**
 * Canonical target for a row the Overview hands the drawer. Overview campaign
 * items carry the served campaign aggregate row, so the drawer must open the
 * campaign — not the root session — whenever the row carries campaign identity.
 */
export const sessionAnalysisTargetForOverviewRow = (row: DashboardRow): SessionAnalysisTarget =>
  row.campaignKey !== undefined && row.campaignTotalCount !== undefined && row.campaignVisibleCount !== undefined
    ? sessionAnalysisTargetForPageItem({ campaignKey: row.campaignKey, kind: 'campaign', row })
    : sessionAnalysisTargetForSession(row);

export const sessionAnalysisTargetForTopLevelRow = (input: {
  campaigns: readonly CampaignView[];
  pageItems: readonly SessionPageItem[];
  row: DashboardRow;
}): SessionAnalysisTarget => {
  const pageItem = input.pageItems.find((item) =>
    input.row.campaignKey === undefined
      ? item.row.rowId === input.row.rowId
      : item.campaignKey === input.row.campaignKey,
  );
  if (pageItem) {
    return sessionAnalysisTargetForPageItem(pageItem);
  }
  const campaign = input.campaigns.find((candidate) =>
    input.row.campaignKey === undefined
      ? candidate.root.rowId === input.row.rowId
      : candidate.campaignKey === input.row.campaignKey,
  );
  if (!campaign) {
    throw new Error('Top-level session rows must resolve to a campaign');
  }
  return sessionAnalysisTargetForCampaign(input.row, campaign);
};
