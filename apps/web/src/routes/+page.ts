import { error } from '@sveltejs/kit';
import { ReportBootstrapUnavailableError, reportPageDataFor } from '$lib/features/report/core/report-bootstrap';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, fetch, parent, untrack, url }) => {
  const rpcBaseUrl = untrack(() => new URL(url.origin));
  // Runtime mode is document-scoped; search navigation must not reacquire the report bootstrap.
  const parentData = await untrack(() => parent());
  try {
    return reportPageDataFor(
      parentData.runtimeMode,
      { fetch: (request) => fetch(request), url: rpcBaseUrl },
      data.reportQueryState,
    );
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
