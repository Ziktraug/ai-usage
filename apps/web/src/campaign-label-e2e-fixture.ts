import { applyCampaignLabelOverrideMutation, type CampaignLabelOverride } from '@ai-usage/report-core/campaign-label';
import type { CampaignLabelApi } from './campaign-label-controller';

export const createCampaignLabelE2EApi = (): CampaignLabelApi => {
  let overrides: CampaignLabelOverride[] = [];
  const response = () => ({ campaignLabelOverrides: overrides.map((override) => ({ ...override })) });

  return {
    load: () => Promise.resolve(response()),
    mutate: (input) => {
      overrides = applyCampaignLabelOverrideMutation(overrides, input);
      return Promise.resolve(response());
    },
  };
};
