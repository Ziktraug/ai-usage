import { type FocusedBreakdownRequest, projectFocusedBreakdown } from '@ai-usage/report-core/focused-report-query';
import { queryOptions } from '@tanstack/svelte-query';
import { campaignMapFixtureGeneratedAt, campaignMapFixtureRows } from '../../../campaign-map-fixture';
import { demoReportPayload } from '../../../report-data';
import type { RuntimeMode } from '../../../runtime-mode';
import { parseDashboardSearchUrl } from '../../foundation/navigation/svelte/dashboard-url';
import { reportBreakdownKey } from '../../query/options/report';
import { webQueryPolicies } from '../../query/policies';
import type { ReportClient } from '../../rpc/report-client';
import { campaignsRequest } from '../campaigns/campaigns-query';
import { dashboardSearchCodec } from '../shell/navigation';

export const observatoryFixtureRevision = 'synthetic-observatory-v1';
export const observatoryFixtureDate = campaignMapFixtureGeneratedAt;
export const observatoryRequest = (url: URL, revision: string, generatedAt: string): FocusedBreakdownRequest => {
  const request = campaignsRequest(parseDashboardSearchUrl(url, dashboardSearchCodec), generatedAt, revision);
  return { includeObservatory: true, query: { filters: request.filters, range: request.range, revision } };
};
export const observatoryQueryOptions = (
  client: Pick<ReportClient, 'getFocusedReportBreakdown'>,
  request: FocusedBreakdownRequest,
  mode: RuntimeMode,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    queryKey: reportBreakdownKey(request),
    queryFn: async ({ signal }) => {
      if (mode !== 'live') {
        return projectFocusedBreakdown(
          campaignMapFixtureRows,
          { ...demoReportPayload, generatedAt: observatoryFixtureDate },
          request,
        );
      }
      const result = await client.getFocusedReportBreakdown(request, { signal });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.data;
    },
  });
