import { redirect } from '@tanstack/solid-router';
import { getBrowserRuntimeMode } from './browser-runtime-mode';
import { dashboardSearchDefaultsFor } from './dashboard-search';

const demoDashboardSearch = dashboardSearchDefaultsFor('date');

export const enforceReportOnlyDemoNavigation = (): void => {
  if (getBrowserRuntimeMode() === 'demo') {
    throw redirect({ replace: true, search: demoDashboardSearch, to: '/' });
  }
};
