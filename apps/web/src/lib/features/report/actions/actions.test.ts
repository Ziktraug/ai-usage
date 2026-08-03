import { describe, expect, test } from 'bun:test';
import { dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import { campaignRenameMutation, campaignResetMutation, preserveCampaignFilterIdentity } from './campaign';
import { copyExactBreakdownUrl, exportVisibleBreakdown, type SharingEnvironment } from './sharing';

const environment = (overrides: Partial<SharingEnvironment> = {}) => {
  const copied: string[] = [];
  const downloaded: { csv: string; filename: string }[] = [];
  const value: SharingEnvironment = {
    copyText: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
    currentUrl: () => 'https://example.test/report?tab=models&provider=openai',
    download: (file) => {
      downloaded.push(file);
    },
    ...overrides,
  };
  return { copied, downloaded, value };
};

describe('P8 report actions', () => {
  test('copies the exact current URL and reports clipboard failures', async () => {
    const success = environment();
    expect(await copyExactBreakdownUrl(success.value)).toEqual({ message: 'Link copied', tone: 'success' });
    expect(success.copied).toEqual(['https://example.test/report?tab=models&provider=openai']);

    const failure = environment({
      copyText: () => Promise.reject(new Error('denied')),
    });
    expect(await copyExactBreakdownUrl(failure.value)).toEqual({
      message: 'Could not copy link',
      tone: 'error',
    });
  });

  test('downloads only the export produced by the visible breakdown and reports failures', async () => {
    const success = environment();
    const file = { csv: 'label,value\nOpenAI,1\n', filename: 'models.csv' };
    expect(await exportVisibleBreakdown(async () => file, success.value)).toEqual({
      message: 'CSV download started',
      tone: 'success',
    });
    expect(success.downloaded).toEqual([file]);

    const failure = environment({
      download: () => {
        throw new Error('blocked');
      },
    });
    expect(await exportVisibleBreakdown(async () => file, failure.value)).toEqual({
      message: 'Could not export CSV',
      tone: 'error',
    });
  });

  test('uses canonical campaign mutations without replacing campaign filter identity', () => {
    expect(campaignRenameMutation('campaign-key', '  New label  ')).toEqual({
      campaignKey: 'campaign-key',
      label: 'New label',
    });
    expect(campaignResetMutation('campaign-key')).toEqual({ campaignKey: 'campaign-key', label: null });
    const search = {
      ...dashboardSearchDefaultsFor('cost'),
      filters: { campaign: 'campaign-key' },
    };
    expect(preserveCampaignFilterIdentity(search, 'campaign-key').filters.campaign).toBe('campaign-key');
  });
});
