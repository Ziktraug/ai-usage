import type { CampaignLabelOverride } from '@ai-usage/report-core/campaign-label';
import type { FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
import { sessionCampaignIdentityForRow } from '@ai-usage/report-core/session-query';
import {
  displayTitle,
  sessionDisplayTitle,
  withSessionDisplayTitle,
} from './lib/foundation/presentation/display-title';
import type { DashboardRow } from './lib/foundation/presentation/report-value';

export interface CampaignLabelContext {
  campaignKey: string;
  derivedLabel: string;
}

export type PresentedFocusedOverviewSessionItem<Item extends FocusedOverviewSessionItem> = Item & {
  campaignLabelContext?: CampaignLabelContext;
};

export type CampaignLabelIndex = ReadonlyMap<string, string>;

export const indexCampaignLabelOverrides = (overrides: readonly CampaignLabelOverride[]): CampaignLabelIndex =>
  new Map(overrides.map(({ campaignKey, label }) => [campaignKey, label]));

export const campaignLabelOverrideFor = (index: CampaignLabelIndex, campaignKey: string): string | undefined =>
  index.get(campaignKey);

export const campaignLabelFor = (index: CampaignLabelIndex, campaignKey: string, derivedLabel: string): string =>
  campaignLabelOverrideFor(index, campaignKey) ?? derivedLabel;

/** Operator labels are literal; only the native/first-prompt fallback is cleaned. */
export const campaignDisplayLabelFor = (index: CampaignLabelIndex, campaignKey: string, derivedLabel: string): string =>
  campaignLabelOverrideFor(index, campaignKey) ?? displayTitle(derivedLabel);

export const presentServedCampaignDisplayRow = (
  row: DashboardRow,
  index: CampaignLabelIndex,
): DashboardRow & { readonly displayTitleOverride?: string } => {
  const campaignKey = row.campaignKey;
  if (!(campaignKey && index.has(campaignKey))) {
    return row;
  }
  return withSessionDisplayTitle(row, campaignLabelFor(index, campaignKey, row.sessionLabel));
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
  const label = campaignDisplayLabelFor(index, campaignKey, series.label);
  return label === series.label ? series : { ...series, label };
};

export const focusedCampaignLabelContext = (
  item: PresentedFocusedOverviewSessionItem<FocusedOverviewSessionItem>,
): CampaignLabelContext | null => {
  if (item.campaignLabelContext) {
    return item.campaignLabelContext;
  }
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
): PresentedFocusedOverviewSessionItem<Item> => {
  const context = focusedCampaignLabelContext(item);
  if (!context) {
    return { ...item, label: sessionDisplayTitle(item.row) };
  }
  return {
    ...item,
    campaignLabelContext: context,
    label: labelFor(context.campaignKey, context.derivedLabel),
  };
};
