import { describe, expect, test } from 'bun:test';
import { campaignMapFixtureGeneratedAt, campaignMapFixtureRootKey } from '../../../campaign-map-fixture';
import { dashboardSearchDefaultsFor, validateDashboardSearch } from '../../../dashboard-search';
import { createHydratedWebQueryClient, createWebQueryClient } from '../../query/client';
import { initialSessionWindowIntent } from '../../query/options/session-window';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { loadCampaignsPageData } from './campaigns-load';
import {
  campaignMatchingMembersOptions,
  campaignMembersOptions,
  campaignsExplorationOptions,
  campaignsListOptions,
  campaignsRequest,
} from './campaigns-query';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

describe('Campaign focused query integration', () => {
  test('a matching child discovers its campaign while inspection restores the full unfiltered hierarchy', async () => {
    const request = campaignsRequest(
      validateDashboardSearch({ q: 'edge cases', range: 'all' }, dashboardSearchDefaultsFor('date')),
      campaignMapFixtureGeneratedAt,
      'campaign-revision-a',
    );
    const client = createSyntheticCampaignClient();
    const queryClient = createWebQueryClient();
    try {
      const list = await queryClient.fetchInfiniteQuery(campaignsListOptions(client, request));
      expect(list.pages[0]?.itemCount).toBe(1);
      expect(list.pages[0]?.items[0]?.campaignKey).toBe(campaignMapFixtureRootKey);
      expect(list.pages[0]?.sessionCount).toBe(1);

      const members = await queryClient.fetchInfiniteQuery(
        campaignMembersOptions(client, request.revision, campaignMapFixtureRootKey),
      );
      expect(members.pages[0]?.root?.name).toBe('Build forecast model');
      expect(members.pages[0]?.items).toHaveLength(4);
      expect(members.pages[0]?.revision).toBe(request.revision);
      expect(members.pages[0]?.root?.tokenTotal).toBe(400_000);
      expect(members.pages[0]?.items.some((row) => row.name === 'Implement market ingestion')).toBe(true);
      const matches = await queryClient.fetchInfiniteQuery(
        campaignMatchingMembersOptions(client, request, campaignMapFixtureRootKey),
      );
      expect(matches.pages[0]?.items).toHaveLength(1);
      expect(matches.pages[0]?.items[0]?.name).toBe('Verify ingestion edge cases');
    } finally {
      queryClient.clear();
    }
  });

  test('does not accept a member response from a different revision', async () => {
    const client = createSyntheticCampaignClient();
    const mismatched: SessionClientAdapter = {
      ...client,
      campaignChildren: async (request, signal) => {
        const result = await client.campaignChildren(request, signal);
        return result.ok ? { ...result, revision: 'another-revision' } : result;
      },
    };
    const queryClient = createWebQueryClient();
    try {
      await expect(
        queryClient.fetchInfiniteQuery(
          campaignMembersOptions(mismatched, 'campaign-revision-a', campaignMapFixtureRootKey),
        ),
      ).rejects.toThrow('exact request');
    } finally {
      queryClient.clear();
    }
  });

  test('demo document hydration satisfies both list and selected map without a network call or refetch', async () => {
    let networkCalls = 0;
    const data = await loadCampaignsPageData(
      {
        fetch: () => {
          networkCalls += 1;
          return Promise.reject(new Error('The demo must never contact an RPC or local store'));
        },
        url: new URL('http://127.0.0.1:4176/campaigns?range=all'),
      },
      'demo',
    );
    expect(networkCalls).toBe(0);
    expect(data.queryState.dehydratedState.queries).toHaveLength(3);
    const client = createSyntheticCampaignClient();
    const forbidRefetch = (): Promise<never> => Promise.reject(new Error('Hydrated exact data was refetched'));
    const hydratedClient: SessionClientAdapter = { ...client, campaignChildren: forbidRefetch, page: forbidRefetch };
    const queryClient = createHydratedWebQueryClient(data.queryState);
    try {
      const request = campaignsRequest(
        validateDashboardSearch({ range: 'all' }, dashboardSearchDefaultsFor('date')),
        campaignMapFixtureGeneratedAt,
        'synthetic-campaign-map-v1',
      );
      const list = await queryClient.fetchInfiniteQuery(campaignsListOptions(hydratedClient, request));
      const map = await queryClient.fetchInfiniteQuery(
        campaignMembersOptions(hydratedClient, request.revision, campaignMapFixtureRootKey),
      );
      expect(list.pages[0]?.items).toHaveLength(4);
      expect(map.pages[0]?.items).toHaveLength(4);
      const exploration = await queryClient.fetchQuery(
        campaignsExplorationOptions({
          client: hydratedClient,
          queryClient,
          request,
          intent: { ...initialSessionWindowIntent(), campaignSessionsDepth: { [campaignMapFixtureRootKey]: 1 } },
        }),
      );
      expect(exploration.list.pages[0]?.items).toHaveLength(4);
      expect(exploration.members[0]?.data.pages[0]?.items).toHaveLength(4);
      expect(queryClient.isFetching()).toBe(0);
    } finally {
      queryClient.clear();
    }
  });
});
