import { error } from '@sveltejs/kit';
import {
  acquireLiveReportQueryState,
  deferredLiveReportQueryState,
  ReportBootstrapUnavailableError,
} from '$lib/features/report/core/report-bootstrap';
import { recordReportHydrationBytes } from '$lib/server/perf/report-hydration-perf';
import type { PageServerLoad } from './$types';

/**
 * Report acquisition lives on the server so SvelteKit serialises the result into the document.
 * A universal `load` would re-run during hydration and re-acquire everything over the network — the
 * serialised SSR fetch cache cannot replay the Overview, whose request body is a Blob by then.
 */
export const load: PageServerLoad = async ({ depends, fetch, isDataRequest, locals, untrack, url }) => {
  depends('ai-usage:report-root');
  if (locals.shellE2eError) {
    error(503, 'Synthetic shell route failure');
  }
  if ((locals.runtimeMode ?? 'live') !== 'live') {
    return {};
  }
  if (isDataRequest) {
    return { reportQueryState: deferredLiveReportQueryState() };
  }
  // Detached copies. Reading a tracked `url` property here would make this load search-scoped, so
  // every filter and range change would refetch __data.json and re-acquire the whole report — work
  // the mounted report already owns, and which delays the refresh it is racing.
  const pageUrl = untrack(() => new URL(url.href));
  const rpcBaseUrl = untrack(() => new URL(url.origin));
  try {
    const reportQueryState = await acquireLiveReportQueryState({
      fetch: (request) => fetch(request),
      pageUrl,
      requestOwner: 'report-root-ssr',
      url: rpcBaseUrl,
    });
    recordReportHydrationBytes(reportQueryState);
    return { reportQueryState };
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
