import {
  isLocalTimeHour,
  isLocalTimeWeekday,
  isSessionOrigin,
  type LocalTimeCell,
  type SessionOrigin,
  sessionOrigins,
} from '@ai-usage/report-core/session-query';
import type { SortingState } from '@tanstack/solid-table';
import { type DateRangeMode, parseLocalDate } from './date-range';
import {
  isSearchableColumnDiffId,
  isSessionColumnId,
  isSessionColumnVisibilityBase,
  type SearchableColumnDiffId,
  type SessionColumnId,
  type SessionColumnVisibilityBase,
} from './session-table-schema';

export const fieldFilterKeys = ['campaign', 'provider', 'model', 'project'] as const;
export type FieldFilterKey = (typeof fieldFilterKeys)[number];
export type FieldFilters = Partial<Record<FieldFilterKey, string>>;

export const toggleExactFieldFilter = (filters: FieldFilters, key: FieldFilterKey, value: string): FieldFilters => {
  const next = { ...filters };
  if (next[key] === value) {
    delete next[key];
    return next;
  }
  next[key] = value;
  return next;
};

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

// Keep the established URL values while projecting them into a smaller visual navigation.
// This lets shared links such as `?tab=projects` select Breakdown > Projects without a migration.
export const breakdownTabs = ['models', 'providers', 'harnesses', 'projects', 'cursor-ai'] as const;
export type BreakdownTab = (typeof breakdownTabs)[number];

export const breakdownSorts = ['value', 'tokens', 'sessions'] as const;
export type BreakdownSort = (typeof breakdownSorts)[number];

export const primaryDashboardTabs = ['overview', 'sessions', 'breakdown'] as const;
export type PrimaryDashboardTab = (typeof primaryDashboardTabs)[number];

const breakdownTabSet = new Set<DashboardTab>(breakdownTabs);

export const isBreakdownTab = (tab: DashboardTab): tab is BreakdownTab => breakdownTabSet.has(tab);

export const primaryDashboardTabFor = (tab: DashboardTab): PrimaryDashboardTab =>
  isBreakdownTab(tab) ? 'breakdown' : tab;

export const breakdownTabFor = (tab: DashboardTab): BreakdownTab => (isBreakdownTab(tab) ? tab : 'models');

type ReportSort = 'date' | 'tokens' | 'cost';

export interface DashboardSort {
  desc: boolean;
  id: SessionColumnId;
}

export interface DashboardDateRangeSearch {
  from?: string;
  mode: DateRangeMode;
  to?: string;
}

export const defaultDashboardDateRangeMode = '30d' as const;
export const defaultDashboardOrigins = [] as const satisfies readonly SessionOrigin[];

const DASHBOARD_TIME_CELL_PATTERN = /^(MON|TUE|WED|THU|FRI|SAT|SUN)-(0[0-9]|1[0-9]|2[0-3])$/;
const dashboardTimeCellWeekdayCodes: readonly string[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const parseDashboardTimeCell = (value: unknown): LocalTimeCell | undefined => {
  if (typeof value !== 'string') {
    return;
  }
  const match = DASHBOARD_TIME_CELL_PATTERN.exec(value);
  const weekday = dashboardTimeCellWeekdayCodes.indexOf(match?.[1] ?? '');
  const hour = Number.parseInt(match?.[2] ?? '', 10);
  if (!(isLocalTimeWeekday(weekday) && isLocalTimeHour(hour))) {
    return;
  }
  return { hour, weekday };
};

export const serializeDashboardTimeCell = (cell: LocalTimeCell): string =>
  `${dashboardTimeCellWeekdayCodes[cell.weekday]}-${String(cell.hour).padStart(2, '0')}`;

export { localTimeCellLabel as dashboardTimeCellLabel } from '@ai-usage/report-core/session-query';

const sameOrigins = (left: readonly SessionOrigin[], right: readonly SessionOrigin[]): boolean =>
  left.length === right.length && left.every((origin, index) => origin === right[index]);

export const isDefaultDashboardOriginSelection = (origins: readonly SessionOrigin[]): boolean =>
  sameOrigins(origins, defaultDashboardOrigins);

export interface DashboardSearch {
  breakdownSort: BreakdownSort;
  cols: SearchableColumnDiffId[];
  colsBase: SessionColumnVisibilityBase;
  filters: FieldFilters;
  harness: string[];
  machine: string[];
  origin: SessionOrigin[];
  q: string;
  range: DashboardDateRangeSearch;
  sort: DashboardSort;
  tab: DashboardTab;
  timeCell?: string;
}

export const withoutDashboardTimeCell = (search: DashboardSearch): DashboardSearch => {
  const { timeCell: _timeCell, ...rest } = search;
  return rest;
};

export const hasActiveDashboardFilters = (search: DashboardSearch): boolean =>
  search.q !== '' ||
  search.harness.length > 0 ||
  search.machine.length > 0 ||
  !isDefaultDashboardOriginSelection(search.origin) ||
  Object.keys(search.filters).length > 0 ||
  search.range.mode !== defaultDashboardDateRangeMode ||
  search.timeCell !== undefined;

const breakdownSortSet = new Set<string>(breakdownSorts);
const dateRangeModes: DateRangeMode[] = ['all', 'today', '7d', '30d', 'custom'];
const dateRangeModeSet = new Set<string>(dateRangeModes);
const fieldFilterKeySet = new Set<string>(fieldFilterKeys);
const dashboardTabSet = new Set<string>(dashboardTabs);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const validDateInput = (value: unknown) => {
  if (typeof value !== 'string') {
    return;
  }
  return parseLocalDate(value) ? value : undefined;
};

const uniqueValidStrings = <T extends string>(values: unknown, isValid: (value: unknown) => value is T): T[] => {
  if (!Array.isArray(values)) {
    return [];
  }
  const next: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (!isValid(value) || seen.has(value)) {
      continue;
    }
    next.push(value);
    seen.add(value);
  }

  return next;
};

export const isDashboardTab = (value: unknown): value is DashboardTab =>
  typeof value === 'string' && dashboardTabSet.has(value);

export const isBreakdownSort = (value: unknown): value is BreakdownSort =>
  typeof value === 'string' && breakdownSortSet.has(value);

export const defaultDashboardSortFor = (sort: ReportSort): DashboardSort => ({
  id: sort === 'tokens' ? 'fresh' : sort,
  desc: true,
});

export const dashboardSearchDefaultsFor = (sort: ReportSort): DashboardSearch => ({
  breakdownSort: 'value',
  cols: [],
  colsBase: 'auto',
  filters: {},
  harness: [],
  machine: [],
  origin: [...defaultDashboardOrigins],
  q: '',
  range: { mode: defaultDashboardDateRangeMode },
  sort: defaultDashboardSortFor(sort),
  tab: 'overview',
});

// Accepts an array (current shape) or a bare string (legacy single-value URLs).
// Drops the old 'all' sentinel so stale links migrate cleanly to "no filter".
const parseStringArray = (value: unknown): string[] => {
  const raw = (() => {
    if (Array.isArray(value)) {
      return value;
    }
    if (value == null) {
      return [];
    }
    return [value];
  })();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const cleaned = cleanString(entry);
    if (cleaned && cleaned !== 'all' && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
};

const parseOrigins = (value: unknown, fallback: SessionOrigin[]): SessionOrigin[] => {
  if (value === undefined) {
    return [...fallback];
  }
  const raw = Array.isArray(value) ? value : [value];
  const parsed = sessionOrigins.filter((origin) =>
    raw.some((candidate) => isSessionOrigin(candidate) && candidate === origin),
  );
  if (parsed.length === sessionOrigins.length) {
    return [];
  }
  return parsed.length > 0 || raw.length === 0 ? parsed : [...fallback];
};

const parseFilters = (value: unknown): FieldFilters => {
  if (!isRecord(value)) {
    return {};
  }
  const filters: FieldFilters = {};
  for (const [key, rawFilter] of Object.entries(value)) {
    if (!fieldFilterKeySet.has(key)) {
      continue;
    }
    const filter = cleanString(rawFilter);
    if (filter) {
      filters[key as FieldFilterKey] = filter;
    }
  }
  return filters;
};

const parseRange = (value: unknown, fallback: DashboardDateRangeSearch): DashboardDateRangeSearch => {
  if (!isRecord(value)) {
    return fallback;
  }

  const mode =
    typeof value.mode === 'string' && dateRangeModeSet.has(value.mode) ? (value.mode as DateRangeMode) : fallback.mode;
  if (mode !== 'custom') {
    return { mode };
  }

  const from = validDateInput(value.from);
  const to = validDateInput(value.to);
  const hasInvalidBound =
    (value.from !== undefined && from === undefined) || (value.to !== undefined && to === undefined);
  const fromDate = from ? parseLocalDate(from) : null;
  const toDate = to ? parseLocalDate(to) : null;
  if (hasInvalidBound || (fromDate && toDate && fromDate > toDate)) {
    return fallback;
  }
  return {
    mode,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
};

const parseSort = (value: unknown, fallback: DashboardSort): DashboardSort => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!(isRecord(candidate) && isSessionColumnId(candidate.id))) {
    return fallback;
  }
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
  const cols = uniqueValidStrings(search.cols, isSearchableColumnDiffId);
  const colsBase = isSessionColumnVisibilityBase(search.colsBase) ? search.colsBase : defaults.colsBase;
  const timeCell = parseDashboardTimeCell(search.timeCell);

  return {
    breakdownSort: isBreakdownSort(search.breakdownSort) ? search.breakdownSort : defaults.breakdownSort,
    cols,
    colsBase,
    filters: parseFilters(search.filters),
    harness: parseStringArray(search.harness),
    machine: parseStringArray(search.machine),
    origin: parseOrigins(search.origin, defaults.origin),
    q,
    range: parseRange(search.range, defaults.range),
    sort: parseSort(search.sort, defaults.sort),
    ...(timeCell === undefined ? {} : { timeCell: serializeDashboardTimeCell(timeCell) }),
    tab: isDashboardTab(search.tab) ? search.tab : defaults.tab,
  };
};

export const sortingStateFromSearch = (sort: DashboardSort): SortingState => [sort];
