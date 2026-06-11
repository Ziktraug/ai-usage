import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/solid-router';
import { Dashboard } from './Dashboard';

const rootRoute = createRootRoute();

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
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
