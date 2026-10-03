import { describe, expect, test } from 'bun:test';
import { campaignMapFixtureGeneratedAt, campaignMapFixtureRootKey } from '../../../campaign-map-fixture';
import { dashboardSearchDefaultsFor } from '../../../dashboard-search';
import { createHydratedWebQueryClient } from '../../query/client';
import { loadCampaignsPageData } from './campaigns-load';
import { campaignMembersOptions, campaignsRequest } from './campaigns-query';
import { readCampaignSelection } from './campaigns-selection';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

const query = campaignsRequest(dashboardSearchDefaultsFor('date'), campaignMapFixtureGeneratedAt, 'selection-test');
const urlFor = (key: string): URL => {
  const url = new URL('http://127.0.0.1/campaigns?range=all');
  url.searchParams.set('selectedCampaign', key);
  return url;
};

describe('Campaign URL selection', () => {
  test('preserves valid identity and distinguishes automatic selection', () => {
    expect(readCampaignSelection(new URL('http://127.0.0.1/campaigns'), query)).toEqual({ status: 'automatic' });
    expect(readCampaignSelection(urlFor(campaignMapFixtureRootKey), query)).toEqual({
      campaignKey: campaignMapFixtureRootKey,
      status: 'selected',
    });
  });

  test.each([
    '',
    '   ',
    ` ${campaignMapFixtureRootKey}`,
    'x'.repeat(513),
  ])('reports malformed selection instead of throwing (%j)', (key) => {
    expect(readCampaignSelection(urlFor(key), query)).toEqual({ status: 'invalid' });
  });

  test('SSR recovers an invalid bookmark into a hydrated recent campaign without transport', async () => {
    const data = await loadCampaignsPageData(
      {
        fetch: () => Promise.reject(new Error('Synthetic selection must not call transport')),
        url: urlFor(' '.repeat(3)),
      },
      'demo',
    );
    const client = createHydratedWebQueryClient(data.queryState);
    try {
      const session = createSyntheticCampaignClient();
      const result = await client.fetchInfiniteQuery(
        campaignMembersOptions(
          {
            ...session,
            campaignChildren: () => Promise.reject(new Error('Expected hydrated fallback campaign')),
          },
          'synthetic-campaign-map-v1',
          campaignMapFixtureRootKey,
        ),
      );
      expect(result.pages[0]?.root?.sessionLabel).toBe('Build forecast model');
    } finally {
      client.clear();
    }
  });
});
