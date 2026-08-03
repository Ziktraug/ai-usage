import {
  breakdownTabFor,
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  type PrimaryDashboardTab,
  primaryDashboardTabFor,
  validateDashboardSearch,
} from '../../../dashboard-search';
import {
  type DashboardSearchCodec,
  dashboardUrlFor,
  parseDashboardSearchUrl,
} from '../../foundation/navigation/svelte/dashboard-url';

export interface ShellDestination {
  readonly href: string;
  readonly label: string;
}

export const shellManagementDestinations = [
  { href: '/skills', label: 'Skills' },
  { href: '/sync', label: 'Sync' },
  { href: '/sources', label: 'Sources' },
] as const satisfies readonly ShellDestination[];

const dashboardSearchCodec: DashboardSearchCodec<DashboardSearch> = {
  defaults: dashboardSearchDefaultsFor('date'),
  validate: validateDashboardSearch,
};

export const activeReportTab = (url: URL): PrimaryDashboardTab =>
  primaryDashboardTabFor(parseDashboardSearchUrl(url, dashboardSearchCodec).tab);

export const reportDestinationUrl = (currentUrl: URL, tab: PrimaryDashboardTab): URL => {
  const search = parseDashboardSearchUrl(currentUrl, dashboardSearchCodec);
  const nextTab = tab === 'breakdown' ? breakdownTabFor(search.tab) : tab;
  const reportUrl = new URL(currentUrl);
  reportUrl.pathname = '/';
  return dashboardUrlFor(reportUrl, { ...search, tab: nextTab }, dashboardSearchCodec);
};

export const isManagementPath = (pathname: string): boolean =>
  shellManagementDestinations.some(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

export const isActiveManagementDestination = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

export const navigationTypeForScroll = (type: string): 'enter' | 'form' | 'goto' | 'leave' | 'link' | 'popstate' => {
  if (type === 'enter' || type === 'form' || type === 'goto' || type === 'leave' || type === 'popstate') {
    return type;
  }
  return 'link';
};

export const shouldPreserveReportScroll = (from: URL | null, to: URL | null): boolean =>
  from?.pathname === '/' && to?.pathname === '/';

export interface HistoryEntryState {
  readonly aiUsageNavigationKey?: string;
}

export const ensureHistoryEntryKey = <State extends object>(
  state: State & HistoryEntryState,
  createKey: () => string,
): {
  readonly key: string;
  readonly state: (State & HistoryEntryState) | (State & { readonly aiUsageNavigationKey: string });
} => {
  if (state.aiUsageNavigationKey) {
    return { key: state.aiUsageNavigationKey, state };
  }
  const key = createKey();
  return { key, state: { ...state, aiUsageNavigationKey: key } };
};
