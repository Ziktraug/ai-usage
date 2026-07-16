import { createFileRoute, stripSearchParams } from '@tanstack/solid-router';
import { createMemo, ErrorBoundary } from 'solid-js';
import { Dashboard } from '../dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from '../dashboard-search';
import { loadReportPayload } from '../report-runtime';

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
  const loaderData = Route.useLoaderData();
  const initial = createMemo(loaderData);
  const initialProps = createMemo(() => {
    const value = initial();
    return value.kind === 'payload' ? { initialPayload: value.payload } : { servedBootstrap: value.bootstrap };
  });
  return (
    <ErrorBoundary fallback={(error) => <pre>{error instanceof Error ? error.message : String(error)}</pre>}>
      <Dashboard {...initialProps()} />
    </ErrorBoundary>
  );
}
