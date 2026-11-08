import { error } from '@sveltejs/kit';
import {
  prefetchReportRoute,
  ReportBootstrapUnavailableError,
  reportPageDataFor,
} from '#lib/features/report/core/report-bootstrap.ts';
import { prefetchNavigationIntent } from '#lib/features/shell/intent-prefetch.ts';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, parent, untrack, url }) => {
  // Runtime mode is document-scoped; search navigation must not reacquire the report bootstrap.
  const parentData = await untrack(() => parent());
  if (parentData.runtimeMode === 'live') {
    const target = untrack(() => new URL(url.href));
    await prefetchNavigationIntent(data.reportQueryState, (runtime) => prefetchReportRoute(runtime, target, {}, true));
  }
  try {
    return reportPageDataFor(parentData.runtimeMode, data.reportQueryState);
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
