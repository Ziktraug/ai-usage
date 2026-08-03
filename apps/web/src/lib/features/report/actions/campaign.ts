import {
  type CampaignLabelOverrideMutation,
  parseCampaignLabelOverrideMutation,
} from '@ai-usage/report-core/campaign-label';
import type { DashboardSearch } from '../../../../dashboard-search';

export const campaignRenameMutation = (campaignKey: string, label: string): CampaignLabelOverrideMutation =>
  parseCampaignLabelOverrideMutation({ campaignKey, label });

export const campaignResetMutation = (campaignKey: string): CampaignLabelOverrideMutation =>
  parseCampaignLabelOverrideMutation({ campaignKey, label: null });

export const preserveCampaignFilterIdentity = (search: DashboardSearch, campaignKey: string): DashboardSearch =>
  search.filters.campaign === campaignKey
    ? { ...search, filters: { ...search.filters, campaign: campaignKey } }
    : search;
