import type { FocusedDateDomain } from '@ai-usage/report-core/focused-report-query';
import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
import {
  DAY_MS,
  dateBoundsForRange,
  dateFromIndex,
  dateIndexFrom,
  endOfDay,
  parseLocalDate,
  rollingDaysAgo,
  startOfDay,
  toDateInputValue,
} from '../../../../date-range';
import type { MigrationGranularity } from '../../../../overview-model';
import type { TimeRangeSelectionIndexes } from '../../../../time-range-control-state';

export const reportRangeEditKey = (range: DashboardDateRangeSearch): string =>
  JSON.stringify([range.mode, range.from ?? null, range.to ?? null]);

export interface ReportRangeProjection {
  readonly dayCount: number;
  readonly displayFrom: string;
  readonly displayTo: string;
  readonly domainFirst: Date;
  readonly domainLast: Date;
  readonly maxIndex: number;
  readonly selectionIndexes: TimeRangeSelectionIndexes;
  readonly summary: string;
}

const inputDateFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' });
const summaryDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });
const summaryEndFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' });

const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const validDomainDate = (value: string | undefined, fallback: Date): Date => {
  if (!value) {
    return fallback;
  }
  const localDate = parseLocalDate(value);
  if (localDate) {
    return localDate;
  }
  if (CANONICAL_DATE_PATTERN.test(value)) {
    return fallback;
  }
  const parsedTimestamp = new Date(value);
  return Number.isFinite(parsedTimestamp.getTime()) ? parsedTimestamp : fallback;
};

export const rangeBounds = (
  range: DashboardDateRangeSearch,
  generatedAt: Date,
): { readonly from: Date | null; readonly to: Date | null } => {
  const bounds = dateBoundsForRange(range.mode, generatedAt, range.from ?? '', range.to ?? '');
  return {
    from: bounds.from ? startOfDay(bounds.from) : null,
    to: bounds.to ? endOfDay(bounds.to) : null,
  };
};

/** True while the selected period still extends past the report's generation instant. */
export const reportPeriodInProgress = (range: DashboardDateRangeSearch, generatedAt: Date): boolean => {
  const { to } = rangeBounds(range, generatedAt);
  return to !== null && to.getTime() > generatedAt.getTime();
};

export const reportRangeProjection = (
  range: DashboardDateRangeSearch,
  generatedAt: Date,
  domain: FocusedDateDomain | null,
): ReportRangeProjection => {
  const fallbackLast = startOfDay(generatedAt);
  const fallbackFirst = rollingDaysAgo(fallbackLast, 30);
  const bounds = rangeBounds(range, generatedAt);
  const selectedFrom = startOfDay(bounds.from ?? validDomainDate(domain?.first, fallbackFirst));
  const selectedTo = startOfDay(
    bounds.to ?? (range.mode === 'all' ? validDomainDate(domain?.last, fallbackLast) : fallbackLast),
  );
  const dataFirst = startOfDay(validDomainDate(domain?.first, selectedFrom));
  const dataLast = startOfDay(validDomainDate(domain?.last, selectedTo));
  const domainFirst = new Date(Math.min(dataFirst.getTime(), selectedFrom.getTime()));
  const domainLast = new Date(Math.max(dataLast.getTime(), selectedTo.getTime()));
  const maxIndex = Math.max(0, dateIndexFrom(domainLast, domainFirst));
  const from = selectedFrom;
  const to = selectedTo;
  const fromIndex = Math.max(0, Math.min(maxIndex, dateIndexFrom(from, domainFirst)));
  const toIndex = Math.max(fromIndex, Math.min(maxIndex, dateIndexFrom(to, domainFirst)));
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  return {
    dayCount: days,
    displayFrom: inputDateFormatter.format(from),
    displayTo: inputDateFormatter.format(to),
    domainFirst,
    domainLast,
    maxIndex,
    selectionIndexes: [fromIndex, toIndex],
    summary: `${summaryDayFormatter.format(from)} → ${summaryEndFormatter.format(to)} · ${days} ${days === 1 ? 'day' : 'days'}`,
  };
};

export type CustomRangeValidation =
  | {
      readonly invalidField: 'from' | 'range' | 'to';
      readonly message: string;
      readonly status: 'invalid';
    }
  | { readonly range: DashboardDateRangeSearch; readonly status: 'valid' };

export const validateCustomRangeInputs = (fromInput: string, toInput: string): CustomRangeValidation => {
  const from = parseLocalDate(fromInput);
  const to = parseLocalDate(toInput, true);
  if (!from) {
    return { invalidField: 'from', message: 'Enter a valid From date (YYYY-MM-DD).', status: 'invalid' };
  }
  if (!to) {
    return { invalidField: 'to', message: 'Enter a valid To date (YYYY-MM-DD).', status: 'invalid' };
  }
  if (from.getTime() > to.getTime()) {
    return {
      invalidField: 'range',
      message: 'From date must be on or before To date.',
      status: 'invalid',
    };
  }
  return {
    range: { from: toDateInputValue(from), mode: 'custom', to: toDateInputValue(to) },
    status: 'valid',
  };
};

export const customRangeFromInputs = (fromInput: string, toInput: string): DashboardDateRangeSearch | null => {
  const validation = validateCustomRangeInputs(fromInput, toInput);
  return validation.status === 'valid' ? validation.range : null;
};

export const customRangeFromIndexes = (
  projection: ReportRangeProjection,
  indexes: TimeRangeSelectionIndexes,
): DashboardDateRangeSearch => {
  const from = dateFromIndex(projection.domainFirst, indexes[0]);
  const to = dateFromIndex(projection.domainFirst, indexes[1]);
  return {
    from: toDateInputValue(startOfDay(from)),
    mode: 'custom',
    to: toDateInputValue(endOfDay(to)),
  };
};

export const inputValueForRange = (date: Date): string => toDateInputValue(date);

export type ReportRangePointerFinishType = 'pointerCancel' | 'pointerCaptureLost' | 'pointerEnd';

export const reportRangePointerFinishType = (eventType: string): ReportRangePointerFinishType => {
  if (eventType === 'pointercancel') {
    return 'pointerCancel';
  }
  if (eventType === 'lostpointercapture') {
    return 'pointerCaptureLost';
  }
  return 'pointerEnd';
};

export const escapedRangeDraft = (
  projection: Pick<ReportRangeProjection, 'displayFrom' | 'displayTo'>,
  field: 'end' | 'start',
): string => (field === 'start' ? projection.displayFrom : projection.displayTo);

export type TimelineGranularityPreference = MigrationGranularity | 'auto';

/** Up to this many selected days the chart keeps one bar per day (the 90d preset is 91). */
export const AUTO_INTERVAL_DAY_LIMIT_DAYS = 120;

/** Up to this many selected days the chart uses weeks; beyond it, months. */
export const AUTO_INTERVAL_WEEK_LIMIT_DAYS = 730;

export const resolveTimelineGranularity = (
  preference: TimelineGranularityPreference,
  selectedDayCount: number,
): MigrationGranularity => {
  if (preference !== 'auto') {
    return preference;
  }
  if (selectedDayCount <= AUTO_INTERVAL_DAY_LIMIT_DAYS) {
    return 'day';
  }
  return selectedDayCount <= AUTO_INTERVAL_WEEK_LIMIT_DAYS ? 'week' : 'month';
};
