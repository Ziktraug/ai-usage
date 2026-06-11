import type { SerializedRow } from '@ai-usage/core/report-data';

export type DateRangeMode = 'all' | 'today' | '7d' | '30d' | 'custom';

const DAY_MS = 86_400_000;

export interface DateBounds {
  from: Date | null;
  to: Date | null;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export const toDateInputValue = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

export const parseLocalDate = (value: string, endOfDay = false) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
};

export const startOfDay = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

export const endOfDay = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
};

export const rollingDaysAgo = (date: Date, days: number) => new Date(date.getTime() - days * DAY_MS);

export const dateBoundsForRange = (
  mode: DateRangeMode,
  generatedAt: Date,
  customFrom: string,
  customTo: string,
): DateBounds => {
  if (mode === 'all') return { from: null, to: null };
  if (mode === 'today') return { from: startOfDay(generatedAt), to: endOfDay(generatedAt) };
  if (mode === '7d') return { from: rollingDaysAgo(generatedAt, 7), to: null };
  if (mode === '30d') return { from: rollingDaysAgo(generatedAt, 30), to: null };
  return {
    from: customFrom ? parseLocalDate(customFrom) : null,
    to: customTo ? parseLocalDate(customTo, true) : null,
  };
};

export const rowTime = (row: SerializedRow) => {
  const value = row.activeDate ?? row.date;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export const rowMatchesDateBounds = (row: SerializedRow, bounds: DateBounds) => {
  const time = rowTime(row);
  if (time == null) return !bounds.from && !bounds.to;
  if (bounds.from && time < bounds.from.getTime()) return false;
  if (bounds.to && time > bounds.to.getTime()) return false;
  return true;
};

export const rowsDateSpan = (rows: SerializedRow[]) => {
  const times = rows.map(rowTime).filter((time): time is number => time != null);
  if (!times.length) return null;
  return {
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
  };
};
