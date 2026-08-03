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
import type { TimeRangeSelectionIndexes } from '../../../../time-range-control-state';

export interface ReportRangeProjection {
  readonly displayFrom: string;
  readonly displayTo: string;
  readonly domainFirst: Date;
  readonly domainLast: Date;
  readonly maxIndex: number;
  readonly selectionIndexes: TimeRangeSelectionIndexes;
  readonly summary: string;
}

const inputDateFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' });
const summaryDayFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short' });
const summaryEndFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' });

const validDomainDate = (value: string | undefined, fallback: Date): Date => {
  const parsed = value ? parseLocalDate(value) : null;
  return parsed ?? fallback;
};

export const rangeBounds = (
  range: DashboardDateRangeSearch,
  generatedAt: Date,
): { readonly from: Date | null; readonly to: Date | null } =>
  dateBoundsForRange(range.mode, generatedAt, range.from ?? '', range.to ?? '');

export const reportRangeProjection = (
  range: DashboardDateRangeSearch,
  generatedAt: Date,
  domain: FocusedDateDomain | null,
): ReportRangeProjection => {
  const fallbackLast = startOfDay(generatedAt);
  const fallbackFirst = rollingDaysAgo(fallbackLast, 30);
  const domainFirst = startOfDay(validDomainDate(domain?.first, fallbackFirst));
  const domainLast = startOfDay(validDomainDate(domain?.last, fallbackLast));
  const maxIndex = Math.max(0, dateIndexFrom(domainLast, domainFirst));
  const bounds = rangeBounds(range, generatedAt);
  const from = startOfDay(bounds.from ?? domainFirst);
  const to = startOfDay(bounds.to ?? domainLast);
  const fromIndex = Math.max(0, Math.min(maxIndex, dateIndexFrom(from, domainFirst)));
  const toIndex = Math.max(fromIndex, Math.min(maxIndex, dateIndexFrom(to, domainFirst)));
  const days = Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  return {
    displayFrom: inputDateFormatter.format(from),
    displayTo: inputDateFormatter.format(to),
    domainFirst,
    domainLast,
    maxIndex,
    selectionIndexes: [fromIndex, toIndex],
    summary: `${summaryDayFormatter.format(from)} → ${summaryEndFormatter.format(to)} · ${days} ${days === 1 ? 'day' : 'days'}`,
  };
};

export const customRangeFromInputs = (fromInput: string, toInput: string): DashboardDateRangeSearch | null => {
  const from = parseLocalDate(fromInput);
  const to = parseLocalDate(toInput, true);
  if (!(from && to) || from.getTime() > to.getTime()) {
    return null;
  }
  return { from: toDateInputValue(from), mode: 'custom', to: toDateInputValue(to) };
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
