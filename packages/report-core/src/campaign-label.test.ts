import { describe, expect, test } from 'bun:test';
import {
  MAX_CAMPAIGN_KEY_BYTES,
  MAX_CAMPAIGN_LABEL_LENGTH,
  MAX_CAMPAIGN_LABEL_OVERRIDES,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from './campaign-label';

describe('campaign label overrides', () => {
  test('trims mutation labels while preserving opaque campaign keys', () => {
    expect(parseCampaignLabelOverrideMutation({ campaignKey: ' campaign:key ', label: '  Release train  ' })).toEqual({
      campaignKey: ' campaign:key ',
      label: 'Release train',
    });
    expect(parseCampaignLabelOverrideMutation({ campaignKey: 'campaign:key', label: null })).toEqual({
      campaignKey: 'campaign:key',
      label: null,
    });
  });

  test('accepts exact field boundaries and rejects values just beyond them', () => {
    const exactKey = 'é'.repeat(MAX_CAMPAIGN_KEY_BYTES / 2);
    const exactLabel = 'x'.repeat(MAX_CAMPAIGN_LABEL_LENGTH);
    expect(parseCampaignLabelOverrides([{ campaignKey: exactKey, label: exactLabel }])).toEqual([
      { campaignKey: exactKey, label: exactLabel },
    ]);
    expect(() => parseCampaignLabelOverrides([{ campaignKey: `${exactKey}a`, label: exactLabel }])).toThrow(
      'campaignKey exceeds',
    );
    expect(() =>
      parseCampaignLabelOverrideMutation({
        campaignKey: 'campaign:key',
        label: `${exactLabel}x`,
      }),
    ).toThrow('label exceeds');
  });

  test('rejects empty keys, empty labels, non-canonical storage, and extra fields', () => {
    expect(() => parseCampaignLabelOverrideMutation({ campaignKey: '', label: 'Name' })).toThrow('campaignKey');
    expect(() => parseCampaignLabelOverrideMutation({ campaignKey: 'campaign:key', label: '   ' })).toThrow(
      'must not be empty',
    );
    expect(() => parseCampaignLabelOverrides([{ campaignKey: 'campaign:key', label: ' Name ' }])).toThrow(
      'stored labels must be trimmed',
    );
    expect(() =>
      parseCampaignLabelOverrideMutation({ campaignKey: 'campaign:key', label: 'Name', portable: true }),
    ).toThrow('expected exactly');
  });

  test('allows shared labels but rejects exact duplicate campaign keys', () => {
    expect(
      parseCampaignLabelOverrides([
        { campaignKey: 'machine-a:codex:root', label: 'Release' },
        { campaignKey: 'machine-b:codex:root', label: 'Release' },
      ]),
    ).toHaveLength(2);
    expect(() =>
      parseCampaignLabelOverrides([
        { campaignKey: 'machine-a:codex:root', label: 'Release' },
        { campaignKey: 'machine-a:codex:root', label: 'Other' },
      ]),
    ).toThrow('duplicate campaignKey');
  });

  test('accepts the exact entry-count boundary and rejects one more', () => {
    const exact = Array.from({ length: MAX_CAMPAIGN_LABEL_OVERRIDES }, (_, index) => ({
      campaignKey: `campaign:${index}`,
      label: 'x',
    }));
    expect(parseCampaignLabelOverrides(exact)).toHaveLength(MAX_CAMPAIGN_LABEL_OVERRIDES);
    expect(() =>
      parseCampaignLabelOverrides([...exact, { campaignKey: `campaign:${MAX_CAMPAIGN_LABEL_OVERRIDES}`, label: 'x' }]),
    ).toThrow('entries');
  });

  test('rejects a canonical list that exceeds the aggregate byte budget', () => {
    const oversized = Array.from({ length: 33 }, (_, index) => {
      const prefix = `${index}:`;
      return {
        campaignKey: `${prefix}${'x'.repeat(MAX_CAMPAIGN_KEY_BYTES - prefix.length)}`,
        label: 'x',
      };
    });
    expect(() => parseCampaignLabelOverrides(oversized)).toThrow('bytes');
  });
});
