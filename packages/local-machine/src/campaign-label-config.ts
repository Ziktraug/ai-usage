import { type CampaignLabelOverride, parseCampaignLabelOverrides } from '@ai-usage/report-core/campaign-label';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { readAiUsageConfig } from './machine-config';

export const readLocalCampaignLabelOverrides = async (): Promise<CampaignLabelOverride[]> => {
  const storage = createLocalHistoryStorage();
  const config = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  return parseCampaignLabelOverrides(config.campaignLabelOverrides ?? []);
};
