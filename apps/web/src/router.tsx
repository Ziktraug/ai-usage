import { createHashHistory } from '@tanstack/history';
import { createRouter } from '@tanstack/solid-router';
import { isStaticReportRuntime } from './report-runtime';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const history = typeof window !== 'undefined' && isStaticReportRuntime() ? createHashHistory() : undefined;
  return createRouter({
    ...(history ? { history } : {}),
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p>Not Found</p>,
  });
}

declare module '@tanstack/solid-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
