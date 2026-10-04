import { campaignMapFixtureGeneratedAt } from '../../../campaign-map-fixture';
import type { RuntimeMode } from '../../../runtime-mode';
import { parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntimeOptions } from '../../query/composition';
import { campaignLabelOverridesQueryOptions, reportBootstrapQueryOptions } from '../../query/options/report';
import { createReportClient } from '../../rpc/report-client';
import { createSessionClientAdapter } from '../../rpc/session-client';
import { requireAvailableReportBootstrap } from '../report/core/report-bootstrap';
import { dashboardSearchCodec } from '../shell/navigation';
import { createAwaitedRouteQueryState } from '../shell/query-load';
import { campaignMembersOptions, campaignsListOptions, campaignsRequest } from './campaigns-query';
import { readCampaignSelection } from './campaigns-selection';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

export interface CampaignsPageData {
  readonly mode: RuntimeMode;
  readonly queryState: WebQueryHydrationState;
}

export const deferredCampaignsPageData = (mode: RuntimeMode): CampaignsPageData => ({
  mode,
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

export const loadCampaignsPageData = async (
  options: WebQueryRuntimeOptions,
  mode: RuntimeMode,
): Promise<CampaignsPageData> => ({
  mode,
  queryState: await createAwaitedRouteQueryState(options, async (runtime) => {
    const sessionClient =
      mode === 'live' ? createSessionClientAdapter(runtime.rpc.session) : createSyntheticCampaignClient();
    const bootstrap =
      mode === 'live'
        ? requireAvailableReportBootstrap(
            await runtime.queryClient.fetchQuery(
              reportBootstrapQueryOptions(createReportClient(runtime.rpc), { browser: false }),
            ),
          )
        : null;
    const revision = bootstrap?.manifest.revision ?? 'synthetic-campaign-map-v1';
    const generatedAt = bootstrap?.bootstrap.support.generatedAt ?? campaignMapFixtureGeneratedAt;
    const request = campaignsRequest(parseDashboardSearchUrl(options.url, dashboardSearchCodec), generatedAt, revision);
    const [list] = await Promise.all([
      runtime.queryClient.fetchInfiniteQuery(campaignsListOptions(sessionClient, request)),
      mode === 'live'
        ? runtime.queryClient.prefetchQuery(
            campaignLabelOverridesQueryOptions(createReportClient(runtime.rpc), { browser: false }),
          )
        : Promise.resolve(),
    ]);
    const selection = readCampaignSelection(options.url, request);
    const selectedKey = selection.status === 'selected' ? selection.campaignKey : list.pages[0]?.items[0]?.campaignKey;
    if (selectedKey) {
      await runtime.queryClient.fetchInfiniteQuery(campaignMembersOptions(sessionClient, revision, selectedKey));
    }
  }),
});
