import { createFileRoute, stripSearchParams } from '@tanstack/solid-router';
import type { UsageReportPayload } from '@ai-usage/core/report-data';
import { createMemo, ErrorBoundary } from 'solid-js';
import { Dashboard } from '../Dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from '../dashboard-search';
import { fetchReportPayload, readReportPayload } from '../report-data';

const fallbackSort = 'date' as const;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(fallbackSort);

const exportPayload = () =>
  typeof globalThis === 'undefined'
    ? undefined
    : (globalThis as { __AI_USAGE_REPORT_EXPORT_PAYLOAD__?: UsageReportPayload }).__AI_USAGE_REPORT_EXPORT_PAYLOAD__;

const loadReportPayload = async () => {
  const payload = exportPayload();
  if (payload) return payload;
  if (typeof window !== 'undefined' && window.__AI_USAGE_REPORT__) return readReportPayload();
  if (import.meta.env.SSR) {
    const { runReportPayloadCollection } = await import('../server/report-payload.server');
    return (await runReportPayloadCollection()) as UsageReportPayload;
  }
  const { getReportPayload } = await import('../server/report-payload');
  return (await getReportPayload()) as UsageReportPayload;
};

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
  const refreshPayload = typeof window === 'undefined' ? undefined : import.meta.env.DEV ? fetchReportPayload : undefined;
  const initialPayload = createMemo(() =>
    typeof window !== 'undefined' && window.__AI_USAGE_REPORT__ ? readReportPayload() : payload(),
  );
  const refreshProps = refreshPayload ? { fetchPayload: () => refreshPayload() as Promise<UsageReportPayload> } : {};
  return (
    <ErrorBoundary fallback={(error) => <pre>{error instanceof Error ? error.message : String(error)}</pre>}>
      <Dashboard initialPayload={initialPayload()} {...refreshProps} />
    </ErrorBoundary>
  );
}
