import { createFileRoute, stripSearchParams } from '@tanstack/solid-router';
import type { UsageReportPayload } from '@ai-usage/core/report-data';
import { createMemo, ErrorBoundary } from 'solid-js';
import { Dashboard } from '../Dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from '../dashboard-search';
import { loadReportPayload, reportRefreshPayload, resolveInitialReportPayload } from '../report-runtime';

const fallbackSort = 'date' as const;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(fallbackSort);

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): DashboardSearch =>
    validateDashboardSearch(search, dashboardSearchDefaults),
  search: {
    middlewares: [stripSearchParams<DashboardSearch>(dashboardSearchDefaults)],
  },
  loader: loadReportPayload,
  component: IndexRoute,
});

function IndexRoute() {
  const payload = Route.useLoaderData();
  const refreshPayload = reportRefreshPayload();
  const initialPayload = createMemo(() => resolveInitialReportPayload(payload()));
  const refreshProps = refreshPayload ? { fetchPayload: () => refreshPayload() as Promise<UsageReportPayload> } : {};
  return (
    <ErrorBoundary fallback={(error) => <pre>{error instanceof Error ? error.message : String(error)}</pre>}>
      <Dashboard initialPayload={initialPayload()} {...refreshProps} />
    </ErrorBoundary>
  );
}
