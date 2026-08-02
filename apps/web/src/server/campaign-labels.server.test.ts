import { describe, expect, test } from 'bun:test';
import {
  applyCampaignLabelOverrideMutation,
  type CampaignLabelOverride,
  type CampaignLabelOverrideMutation,
  MAX_CAMPAIGN_KEY_BYTES,
  MAX_CAMPAIGN_LABEL_LENGTH,
} from '@ai-usage/report-core/campaign-label';
import { getCampaignLabelOverridesForServer, setCampaignLabelOverrideForServer } from './campaign-labels.server';

const campaignLabelFixture = () => {
  let overrides: CampaignLabelOverride[] = [];
  const execute = (command: { campaignKey: string; label: string | null }): Promise<void> => {
    overrides = applyCampaignLabelOverrideMutation(overrides, {
      campaignKey: command.campaignKey,
      label: command.label,
    });
    return Promise.resolve();
  };
  const read = (): Promise<CampaignLabelOverride[]> => Promise.resolve(overrides.map((override) => ({ ...override })));
  const mutate = async (input: CampaignLabelOverrideMutation) =>
    await setCampaignLabelOverrideForServer(input, execute, read);
  return { mutate, read };
};

describe('campaign label server boundary', () => {
  test('routes ordered rename and reset mutations through the engine command boundary', async () => {
    const { mutate, read } = campaignLabelFixture();
    expect(await getCampaignLabelOverridesForServer(read)).toEqual({ campaignLabelOverrides: [] });
    expect(await mutate({ campaignKey: 'machine-a:codex:root-a', label: '  Release train  ' })).toEqual({
      campaignLabelOverrides: [{ campaignKey: 'machine-a:codex:root-a', label: 'Release train' }],
    });
    await mutate({ campaignKey: 'machine-b:claude:root-b', label: 'Migration' });
    expect(await mutate({ campaignKey: 'machine-a:codex:root-a', label: 'Launch' })).toEqual({
      campaignLabelOverrides: [
        { campaignKey: 'machine-a:codex:root-a', label: 'Launch' },
        { campaignKey: 'machine-b:claude:root-b', label: 'Migration' },
      ],
    });
    await mutate({ campaignKey: 'machine-a:codex:root-a', label: null });
    expect(await mutate({ campaignKey: 'machine-b:claude:root-b', label: null })).toEqual({
      campaignLabelOverrides: [],
    });
  });

  test('validates exact mutation boundaries before command admission', async () => {
    const { mutate, read } = campaignLabelFixture();
    const exactLabel = 'x'.repeat(MAX_CAMPAIGN_LABEL_LENGTH);
    const exactKey = 'é'.repeat(MAX_CAMPAIGN_KEY_BYTES / 2);
    await expect(mutate({ campaignKey: exactKey, label: exactLabel })).resolves.toEqual({
      campaignLabelOverrides: [{ campaignKey: exactKey, label: exactLabel }],
    });
    await expect(mutate({ campaignKey: `${exactKey}a`, label: 'Name' })).rejects.toThrow('campaignKey exceeds');
    await expect(mutate({ campaignKey: 'campaign:other', label: `${exactLabel}x` })).rejects.toThrow('label exceeds');
    await expect(mutate({ campaignKey: 'campaign:other', label: '   ' })).rejects.toThrow('must not be empty');
    expect(await read()).toEqual([{ campaignKey: exactKey, label: exactLabel }]);
  });
});
