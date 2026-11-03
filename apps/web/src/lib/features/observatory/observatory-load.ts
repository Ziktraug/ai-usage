import type { RuntimeMode } from '../../../runtime-mode';
import type { WebQueryHydrationState } from '../../query/client';
import { reportBootstrapQueryOptions } from '../../query/options/report';
import { createReportClient } from '../../rpc/report-client';
import { requireAvailableReportBootstrap } from '../report/core/report-bootstrap';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import {
  observatoryFixtureDate,
  observatoryFixtureRevision,
  observatoryQueryOptions,
  observatoryRequest,
} from './observatory-query';

export interface ObservatoryPageData {
  mode: RuntimeMode;
  queryState: WebQueryHydrationState;
}
export const loadObservatoryPage = async (
  options: RouteQueryLoadOptions,
  mode: RuntimeMode,
): Promise<ObservatoryPageData> => ({
  mode,
  queryState: await createAwaitedRouteQueryState(options, async (runtime) => {
    const client = createReportClient(runtime.rpc);
    const bootstrap =
      mode === 'live'
        ? requireAvailableReportBootstrap(
            await runtime.queryClient.query(reportBootstrapQueryOptions(client, { browser: false })),
          )
        : null;
    await runtime.queryClient.query(
      observatoryQueryOptions(
        client,
        observatoryRequest(
          options.url,
          bootstrap?.manifest.revision ?? observatoryFixtureRevision,
          bootstrap?.manifest.generatedAt ?? observatoryFixtureDate,
        ),
        mode,
      ),
    );
  }),
});
