import { error } from '@sveltejs/kit';
import { deferredCampaignsPageData, loadCampaignsPageData } from '#lib/features/campaigns/campaigns-load.ts';
import { ReportBootstrapUnavailableError } from '#lib/features/report/core/report-bootstrap.ts';
import { SessionRevisionExpiredError } from '#lib/query/options/session-window.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ isDataRequest, locals, request, untrack, url }) => {
  const mode = locals.runtimeMode ?? 'live';
  if (isDataRequest) {
    return deferredCampaignsPageData(mode);
  }
  try {
    return await loadCampaignsPageData(
      { rpc: await createInProcessWebRpcClient(request), url: untrack(() => new URL(url.href)) },
      mode,
    );
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError || cause instanceof SessionRevisionExpiredError) {
      error(503, cause.message);
    }
    throw cause;
  }
};
