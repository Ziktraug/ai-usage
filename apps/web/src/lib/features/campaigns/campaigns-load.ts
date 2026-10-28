import {
  parseSessionLookupRequest,
  type SessionLookupRequest,
  SessionQueryValidationError,
} from '@ai-usage/report-core/session-query';
import { campaignMapFixtureGeneratedAt } from '../../../campaign-map-fixture';
import type { RuntimeMode } from '../../../runtime-mode';
import { parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
import type { WebQueryHydrationState } from '../../query/client';
import { campaignLabelOverridesQueryOptions, reportBootstrapQueryOptions } from '../../query/options/report';
import { sessionLookupQueryOptions } from '../../query/options/session';
import { initialSessionWindowIntent } from '../../query/options/session-window';
import { createReportClient } from '../../rpc/report-client';
import { createSessionClientAdapter } from '../../rpc/session-client';
import { requireAvailableReportBootstrap } from '../report/core/report-bootstrap';
import { dashboardSearchCodec } from '../shell/navigation';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import { campaignTimelineRange } from './campaign-timeline-model';
import { campaignsExplorationOptions, campaignsListOptions, campaignsRequest } from './campaigns-query';
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
  options: RouteQueryLoadOptions,
  mode: RuntimeMode,
): Promise<CampaignsPageData> => ({
  mode,
  queryState: await createAwaitedRouteQueryState(options, async (runtime) => {
    const sessionClient =
      mode === 'live' ? createSessionClientAdapter(runtime.rpc.session) : createSyntheticCampaignClient();
    const bootstrap =
      mode === 'live'
        ? requireAvailableReportBootstrap(
            await runtime.queryClient.query(
              reportBootstrapQueryOptions(createReportClient(runtime.rpc), { browser: false }),
            ),
          )
        : null;
    const revision = bootstrap?.manifest.revision ?? 'synthetic-campaign-map-v1';
    const generatedAt = bootstrap?.bootstrap.support.generatedAt ?? campaignMapFixtureGeneratedAt;
    const search = parseDashboardSearchUrl(options.url, dashboardSearchCodec);
    const request = campaignsRequest(search, generatedAt, revision);
    const [list] = await Promise.all([
      runtime.queryClient.infiniteQuery(campaignsListOptions(sessionClient, request)),
      mode === 'live'
        ? runtime.queryClient
            .query(campaignLabelOverridesQueryOptions(createReportClient(runtime.rpc), { browser: false }))
            // Saved labels are optional data (plan 068, SSR rule 7), so a failed read must not fail
            // the page. It is not dehydrated either: the page's labels query starts empty, requests
            // the labels again in the browser and, if that fails too, says so beside the derived
            // titles ("Saved campaign labels are unavailable", campaigns-page.svelte).
            .catch(() => undefined)
        : Promise.resolve(),
    ]);
    const selection = readCampaignSelection(options.url, request);
    const selectedKey = selection.status === 'selected' ? selection.campaignKey : list.pages[0]?.items[0]?.campaignKey;
    if (selectedKey) {
      const exploration = await runtime.queryClient.query(
        campaignsExplorationOptions({
          client: sessionClient,
          intent: { ...initialSessionWindowIntent(), campaignSessionsDepth: { [selectedKey]: 1 } },
          queryClient: runtime.queryClient,
          request,
          timelineRange: campaignTimelineRange(search.range, generatedAt),
        }),
      );
      const selectedRowId = options.url.searchParams.get('selectedSession');
      if (!selectedRowId) {
        return;
      }
      const knownPages = exploration.members.find((entry) => entry.campaignKey === selectedKey)?.data.pages ?? [];
      if (
        knownPages.some(
          (page) => page.root?.rowId === selectedRowId || page.items.some((row) => row.rowId === selectedRowId),
        )
      ) {
        return;
      }
      let lookupRequest: SessionLookupRequest;
      try {
        lookupRequest = parseSessionLookupRequest({ revision: exploration.request.revision, rowId: selectedRowId });
      } catch (cause) {
        if (cause instanceof SessionQueryValidationError) {
          return;
        }
        throw cause;
      }
      // The browser observes this same exact identity. Hydrate metadata only;
      // native history remains behind its dependent detail query.
      await runtime.queryClient.query(sessionLookupQueryOptions(sessionClient, lookupRequest, { browser: false }));
    }
  }),
});
