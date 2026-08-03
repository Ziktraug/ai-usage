import { error } from '@sveltejs/kit';
import { loadReportPageData, ReportBootstrapUnavailableError } from '$lib/features/report/core/report-bootstrap';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent, url }) => {
  const parentData = await parent();
  try {
    return await loadReportPageData({
      fetch: (request) => fetch(request),
      mode: parentData.runtimeMode,
      requestOwner: 'report-root-ssr',
      url,
    });
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
