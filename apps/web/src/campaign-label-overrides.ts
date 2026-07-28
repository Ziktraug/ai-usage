import type { CampaignLabelOverride } from '@ai-usage/report-core/campaign-label';
import type { FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
import { sessionCampaignIdentityForRow } from '@ai-usage/report-core/session-query';
import type { DashboardRow } from './shared';

export interface CampaignLabelContext {
  campaignKey: string;
  derivedLabel: string;
}

export type CampaignLabelIndex = ReadonlyMap<string, string>;

export const indexCampaignLabelOverrides = (overrides: readonly CampaignLabelOverride[]): CampaignLabelIndex =>
  new Map(overrides.map(({ campaignKey, label }) => [campaignKey, label]));

export const campaignLabelOverrideFor = (index: CampaignLabelIndex, campaignKey: string): string | undefined =>
  index.get(campaignKey);

export const campaignLabelFor = (index: CampaignLabelIndex, campaignKey: string, derivedLabel: string): string =>
  campaignLabelOverrideFor(index, campaignKey) ?? derivedLabel;

export const presentServedCampaignDisplayRow = (row: DashboardRow, index: CampaignLabelIndex): DashboardRow => {
  const campaignKey = row.campaignKey;
  if (!(campaignKey && index.has(campaignKey))) {
    return row;
  }
  return { ...row, sessionLabel: campaignLabelFor(index, campaignKey, row.sessionLabel) };
};

export const presentCampaignTimelineSeries = <Series extends { key: string; label: string }>(
  series: Series,
  index: CampaignLabelIndex,
): Series => {
  const campaignPrefix = 'campaign:';
  if (!series.key.startsWith(campaignPrefix)) {
    return series;
  }
  const campaignKey = series.key.slice(campaignPrefix.length);
  if (!index.has(campaignKey)) {
    return series;
  }
  return { ...series, label: campaignLabelFor(index, campaignKey, series.label) };
};

export const focusedCampaignLabelContext = (item: FocusedOverviewSessionItem): CampaignLabelContext | null => {
  if (item.kind !== 'campaign') {
    return null;
  }
  return {
    campaignKey: sessionCampaignIdentityForRow(item.row).campaignKey,
    derivedLabel: item.label,
  };
};

export const presentFocusedOverviewSessionItem = <Item extends FocusedOverviewSessionItem>(
  item: Item,
  labelFor: (campaignKey: string, derivedLabel: string) => string,
): Item => {
  const context = focusedCampaignLabelContext(item);
  if (!context) {
    return item;
  }
  return { ...item, label: labelFor(context.campaignKey, context.derivedLabel) };
};
