import type { SortingState } from '@tanstack/solid-table';
import { type DateRangeMode, parseLocalDate } from './date-range';
import {
  isSearchableColumnDiffId,
  isSessionColumnId,
  type SearchableColumnDiffId,
  type SessionColumnId,
} from './session-table-schema';

export const fieldFilterKeys = ['provider', 'model', 'project'] as const;
export type FieldFilterKey = (typeof fieldFilterKeys)[number];
export type FieldFilters = Partial<Record<FieldFilterKey, string>>;

export const dashboardTabs = [
  'overview',
  'sessions',
  'models',
  'providers',
  'harnesses',
  'projects',
  'cursor-ai',
] as const;
export type DashboardTab = (typeof dashboardTabs)[number];

type ReportSort = 'date' | 'tokens' | 'cost';

export type DashboardSort = {
  desc: boolean;
  id: SessionColumnId;
};

export type DashboardDateRangeSearch = {
  from?: string;
  mode: DateRangeMode;
  to?: string;
};

export type DashboardSearch = {
  cols: SearchableColumnDiffId[];
  filters: FieldFilters;
  harness: string;
  q: string;
  range: DashboardDateRangeSearch;
  sort: DashboardSort;
  tab: DashboardTab;
};

const dateRangeModes: DateRangeMode[] = ['all', 'today', '7d', '30d', 'custom'];
const dateRangeModeSet = new Set<string>(dateRangeModes);
const fieldFilterKeySet = new Set<string>(fieldFilterKeys);
const dashboardTabSet = new Set<string>(dashboardTabs);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const validDateInput = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  return parseLocalDate(value) ? value : undefined;
};

const uniqueValidStrings = <T extends string>(values: unknown, isValid: (value: unknown) => value is T): T[] => {
  if (!Array.isArray(values)) return [];
  const next: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (!isValid(value) || seen.has(value)) continue;
    next.push(value);
    seen.add(value);
  }
  return next;
};

export const isDashboardTab = (value: unknown): value is DashboardTab =>
  typeof value === 'string' && dashboardTabSet.has(value);

export const defaultDashboardSortFor = (sort: ReportSort): DashboardSort => ({
  id: sort === 'tokens' ? 'fresh' : sort,
  desc: true,
});

export const dashboardSearchDefaultsFor = (sort: ReportSort): DashboardSearch => ({
  cols: [],
  filters: {},
  harness: 'all',
  q: '',
  range: { mode: 'all' },
  sort: defaultDashboardSortFor(sort),
  tab: 'overview',
});

const parseFilters = (value: unknown): FieldFilters => {
  if (!isRecord(value)) return {};
  const filters: FieldFilters = {};
  for (const [key, rawFilter] of Object.entries(value)) {
    if (!fieldFilterKeySet.has(key)) continue;
    const filter = cleanString(rawFilter);
    if (filter) filters[key as FieldFilterKey] = filter;
  }
  return filters;
};

const parseRange = (value: unknown, fallback: DashboardDateRangeSearch): DashboardDateRangeSearch => {
  if (!isRecord(value)) return fallback;

  const mode =
    typeof value.mode === 'string' && dateRangeModeSet.has(value.mode) ? (value.mode as DateRangeMode) : fallback.mode;
  if (mode !== 'custom') return { mode };

  const from = validDateInput(value.from);
  const to = validDateInput(value.to);
  return {
    mode,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
};

const parseSort = (value: unknown, fallback: DashboardSort): DashboardSort => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate) || !isSessionColumnId(candidate.id)) return fallback;
  return {
    id: candidate.id,
    desc: typeof candidate.desc === 'boolean' ? candidate.desc : fallback.desc,
  };
};

export const validateDashboardSearch = (
  search: Record<string, unknown>,
  defaults: DashboardSearch,
): DashboardSearch => {
  const q = cleanString(search.q);
  const harness = cleanString(search.harness);

  return {
    cols: uniqueValidStrings(search.cols, isSearchableColumnDiffId),
    filters: parseFilters(search.filters),
    harness: harness || defaults.harness,
    q,
    range: parseRange(search.range, defaults.range),
    sort: parseSort(search.sort, defaults.sort),
    tab: isDashboardTab(search.tab) ? search.tab : defaults.tab,
  };
};

export const sortingStateFromSearch = (sort: DashboardSort): SortingState => [sort];
