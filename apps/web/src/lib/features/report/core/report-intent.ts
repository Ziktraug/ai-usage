import type { RuntimeMode } from '../../../../runtime-mode';
import { prefetchReportDestinationIntent } from '../../../query/options/report-destination';
import { createReportClient } from '../../../rpc/report-client';
import { createSessionClientAdapter } from '../../../rpc/session-client';
import { isReportPathname } from '../../sessions/detail/session-route';
import { prefetchNavigationIntent } from '../../shell/intent-prefetch';
import type { ReportTabIntentTarget } from '../composition/report-tab-target';

type ReportIntentResolver = (url: URL) => ReportTabIntentTarget | null;
let mountedResolver: ReportIntentResolver | undefined;

export const installReportIntentResolver = (resolver: ReportIntentResolver): (() => void) => {
  if (typeof window === 'undefined') {
    throw new Error('The report intent resolver is browser-only');
  }
  mountedResolver = resolver;
  return () => {
    if (mountedResolver === resolver) {
      mountedResolver = undefined;
    }
  };
};

/** Report tabs share a mounted layout, so search-only intent must warm their exact destination. */
export const prefetchReportTabIntent = (url: URL, mode: RuntimeMode): Promise<void> => {
  const resolve = mountedResolver;
  if (mode !== 'live' || !isReportPathname(url.pathname) || !resolve) {
    return Promise.resolve();
  }
  return prefetchNavigationIntent({ dehydratedState: { mutations: [], queries: [] } }, async (runtime) => {
    const target = resolve(url);
    if (!target || mountedResolver !== resolve) {
      return;
    }
    await prefetchReportDestinationIntent(
      {
        queryClient: runtime.queryClient,
        reportClient: createReportClient(runtime.rpc),
        sessionClient: createSessionClientAdapter(runtime.rpc.session),
      },
      target.destination,
      { browser: true, preserveSessionRevision: target.preserveSessionRevision },
      target.sessionWindowIntent,
    );
  });
};
