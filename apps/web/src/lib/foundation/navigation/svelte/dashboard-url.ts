import type { SearchNavigationIntent, SearchNavigationOptions } from '../search-intent';
import type { NavigationPort } from './navigation';
import { parseTanStackSearch, stringifyTanStackSearch } from './search-codec';

const dashboardKeys = [
  'breakdownSort',
  'cols',
  'colsBase',
  'filters',
  'harness',
  'machine',
  'origin',
  'q',
  'range',
  'sort',
  'tab',
  'timeCell',
] as const;

type DashboardSearchKey = (typeof dashboardKeys)[number];
type DashboardUrlSearch = Partial<Record<DashboardSearchKey, unknown>>;

export interface DashboardSearchCodec<Search extends DashboardUrlSearch> {
  readonly defaults: Search;
  readonly validate: (raw: Record<string, unknown>, defaults: Search) => Search;
}

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const dashboardRecord = (search: DashboardUrlSearch): Record<string, unknown> =>
  Object.fromEntries(dashboardKeys.map((key) => [key, search[key]]));

export const parseDashboardSearchUrl = <Search extends DashboardUrlSearch>(
  url: URL,
  codec: DashboardSearchCodec<Search>,
): Search => codec.validate(parseTanStackSearch(url.search), codec.defaults);

export const dashboardUrlFor = <Search extends DashboardUrlSearch>(
  currentUrl: URL,
  search: Search,
  codec: DashboardSearchCodec<Search>,
): URL => {
  const next = new URL(currentUrl);
  const canonical = codec.validate(dashboardRecord(search), codec.defaults);
  const encoded = new URLSearchParams(stringifyTanStackSearch(dashboardRecord(canonical)));
  for (const key of dashboardKeys) {
    next.searchParams.delete(key);
    if (!sameValue(canonical[key], codec.defaults[key])) {
      const value = encoded.get(key);
      if (value !== null) {
        next.searchParams.set(key, value);
      }
    }
  }
  return next;
};

export const createDashboardSearchNavigation =
  <Search extends DashboardUrlSearch>(
    port: NavigationPort,
    codec: DashboardSearchCodec<Search>,
  ): SearchNavigationIntent<Search> =>
  (update, options) => {
    const currentUrl = port.currentUrl();
    const nextSearch = update(parseDashboardSearchUrl(currentUrl, codec));
    port
      .navigate({
        ...(options?.replace === undefined ? {} : { replace: options.replace }),
        resetScroll: options?.resetScroll ?? false,
        url: dashboardUrlFor(currentUrl, nextSearch, codec),
      })
      .catch(() => undefined);
  };

export interface SearchEditRun {
  readonly commit: () => void;
  readonly next: () => SearchNavigationOptions;
}

export const createSearchEditRun = (): SearchEditRun => {
  let active = false;
  return {
    commit: () => {
      active = false;
    },
    next: () => {
      const replace = active;
      active = true;
      return { replace, resetScroll: false };
    },
  };
};
