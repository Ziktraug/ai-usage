import type { RuntimeMode } from '../../runtime-mode';
import {
  observatoryFixtureDate,
  observatoryFixtureRevision,
  observatoryQueryOptions,
  observatoryRequest,
} from '../features/observatory/observatory-query';
import { requireAvailableReportBootstrap } from '../features/report/core/report-bootstrap';
import { createReportClient } from '../rpc/report-client';
import type { WebQueryRuntime } from './composition';
import { reportBootstrapQueryOptions } from './options/report';

/** Request-scoped acquisition; route loaders only arrange hydration ownership. */
export const prefetchObservatory = async (runtime: WebQueryRuntime, url: URL, mode: RuntimeMode): Promise<void> => {
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
        url,
        bootstrap?.manifest.revision ?? observatoryFixtureRevision,
        bootstrap?.manifest.generatedAt ?? observatoryFixtureDate,
      ),
      mode,
    ),
  );
};
