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
  readonly encode?: (search: Search) => DashboardUrlSearch;
  readonly validate: (raw: Record<string, unknown>, defaults: Search) => Search;
}

export interface DashboardNavigationFailure {
  readonly cause: unknown;
  readonly url: URL;
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
  const encodedSearch = codec.encode ? codec.encode(canonical) : canonical;
  const encoded = new URLSearchParams(stringifyTanStackSearch(dashboardRecord(encodedSearch)));
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
    reportFailure: (failure: DashboardNavigationFailure) => void,
  ): SearchNavigationIntent<Search> =>
  (update, options) => {
    const currentUrl = port.currentUrl();
    const nextSearch = update(parseDashboardSearchUrl(currentUrl, codec));
    const url = dashboardUrlFor(currentUrl, nextSearch, codec);
    if (url.href === currentUrl.href) {
      return;
    }
    port
      .navigate({
        ...(options?.keepFocus === undefined ? {} : { keepFocus: options.keepFocus }),
        ...(options?.replace === undefined ? {} : { replace: options.replace }),
        resetScroll: options?.resetScroll ?? false,
        url,
      })
      .catch((cause: unknown) => reportFailure({ cause, url }));
  };

export interface SearchEditRun {
  readonly commit: () => void;
  readonly next: (key?: string) => SearchNavigationOptions | undefined;
  readonly synchronize: (key: string) => void;
}

export const createSearchEditRun = (initialKey?: string): SearchEditRun => {
  let active = false;
  let key = initialKey;
  return {
    commit: () => {
      active = false;
    },
    next: (nextKey) => {
      if (nextKey !== undefined && nextKey === key) {
        return;
      }
      const replace = active;
      active = true;
      key = nextKey;
      return { keepFocus: true, replace, resetScroll: false };
    },
    synchronize: (nextKey) => {
      if (nextKey === key) {
        return;
      }
      active = false;
      key = nextKey;
    },
  };
};
