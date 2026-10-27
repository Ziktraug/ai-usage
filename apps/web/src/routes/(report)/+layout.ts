import { error } from '@sveltejs/kit';
import { ReportBootstrapUnavailableError, reportPageDataFor } from '#lib/features/report/core/report-bootstrap.ts';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, parent, untrack }) => {
  // Runtime mode is document-scoped; search navigation must not reacquire the report bootstrap.
  const parentData = await untrack(() => parent());
  try {
    return reportPageDataFor(parentData.runtimeMode, data.reportQueryState);
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
