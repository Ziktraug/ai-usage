import {
  type CampaignLabelOverride,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import type { CampaignLabelApi } from './campaign-label-controller';

export const createCampaignLabelE2EApi = (): CampaignLabelApi => {
  let overrides: CampaignLabelOverride[] = [];
  const response = () => ({ campaignLabelOverrides: overrides.map((override) => ({ ...override })) });

  return {
    load: () => Promise.resolve(response()),
    mutate: (input) => {
      const mutation = parseCampaignLabelOverrideMutation(input);
      const existingIndex = overrides.findIndex(({ campaignKey }) => campaignKey === mutation.campaignKey);
      if (mutation.label === null) {
        overrides = overrides.filter(({ campaignKey }) => campaignKey !== mutation.campaignKey);
      } else if (existingIndex >= 0) {
        const next = [...overrides];
        next[existingIndex] = { campaignKey: mutation.campaignKey, label: mutation.label };
        overrides = next;
      } else {
        overrides = [...overrides, { campaignKey: mutation.campaignKey, label: mutation.label }];
      }
      overrides = parseCampaignLabelOverrides(overrides);
      return Promise.resolve(response());
    },
  };
};
