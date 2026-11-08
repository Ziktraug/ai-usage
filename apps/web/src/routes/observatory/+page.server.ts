import { error } from '@sveltejs/kit';
import { loadObservatoryPage } from '#lib/features/observatory/observatory-load.ts';
import { ReportBootstrapUnavailableError } from '#lib/features/report/core/report-bootstrap.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, request, url }) => {
  try {
    return await loadObservatoryPage(
      { rpc: await createInProcessWebRpcClient(request), url: new URL(url.href) },
      locals.runtimeMode ?? 'live',
    );
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(503, cause.message);
    }
    throw cause;
  }
};
