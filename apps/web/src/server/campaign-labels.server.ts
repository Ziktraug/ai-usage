import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { readAiUsageConfig, updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import {
  applyCampaignLabelOverrideMutation,
  type CampaignLabelOverride,
  type CampaignLabelOverrideMutation,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import { Effect } from 'effect';

export const getCampaignLabelOverridesForServer = async (
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const config = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  return { campaignLabelOverrides: parseCampaignLabelOverrides(config.campaignLabelOverrides ?? []) };
};

export const setCampaignLabelOverrideForServer = async (
  input: CampaignLabelOverrideMutation,
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const mutation = parseCampaignLabelOverrideMutation(input);
  const config = await Effect.runPromise(
    updateAiUsageConfig((currentConfig) => {
      const campaignLabelOverrides = applyCampaignLabelOverrideMutation(
        currentConfig.campaignLabelOverrides ?? [],
        mutation,
      );
      if (campaignLabelOverrides.length === 0) {
        const { campaignLabelOverrides: _campaignLabelOverrides, ...rest } = currentConfig;
        return rest;
      }
      return { ...currentConfig, campaignLabelOverrides };
    }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
  );
  return { campaignLabelOverrides: parseCampaignLabelOverrides(config.campaignLabelOverrides ?? []) };
};
