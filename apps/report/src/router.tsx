import { createRootRoute, createRoute, createRouter, RouterProvider, stripSearchParams } from '@tanstack/solid-router';
import { Dashboard } from './Dashboard';
import { type DashboardSearch, dashboardSearchDefaultsFor, validateDashboardSearch } from './dashboard-search';
import { readReportPayload } from './report-data';

const rootRoute = createRootRoute();
const dashboardSearchDefaults = dashboardSearchDefaultsFor(readReportPayload().filters.sort);

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): DashboardSearch =>
    validateDashboardSearch(search, dashboardSearchDefaults),
  search: {
    middlewares: [stripSearchParams<DashboardSearch>(dashboardSearchDefaults)],
  },
  component: Dashboard,
});

const routeTree = rootRoute.addChildren([dashboardRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/solid-router' {
  interface Register {
    router: typeof router;
  }
}

export const AppRouter = () => <RouterProvider router={router} />;
