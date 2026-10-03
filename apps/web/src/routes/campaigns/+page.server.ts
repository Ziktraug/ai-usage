import { error } from '@sveltejs/kit';
import { deferredCampaignsPageData, loadCampaignsPageData } from '$lib/features/campaigns/campaigns-load';
import { ReportBootstrapUnavailableError } from '$lib/features/report/core/report-bootstrap';
import { SessionRevisionExpiredError } from '$lib/query/options/session-window';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, isDataRequest, locals, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  if (isDataRequest) {
    return deferredCampaignsPageData(mode);
  }
  try {
    return await loadCampaignsPageData(
      { fetch, requestOwner: 'campaigns-root-ssr', url: untrack(() => new URL(url.href)) },
      mode,
    );
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError || cause instanceof SessionRevisionExpiredError) {
      error(503, cause.message);
    }
    throw cause;
  }
};
