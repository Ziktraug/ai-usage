import { error } from '@sveltejs/kit';
import { loadReportPageData, ReportBootstrapUnavailableError } from '$lib/features/report/core/report-bootstrap';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent, untrack, url }) => {
  const rpcBaseUrl = untrack(() => new URL(url.origin));
  // Runtime mode is document-scoped; search navigation must not reacquire the report bootstrap.
  const parentData = await untrack(() => parent());
  try {
    return await loadReportPageData({
      fetch: (request) => fetch(request),
      mode: parentData.runtimeMode,
      requestOwner: 'report-root-ssr',
      url: rpcBaseUrl,
    });
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
