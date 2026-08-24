const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
});
const dateOnlyFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
});

export const fmtNum = (value: number): string => numberFormatter.format(value);

export const fmtMoney = (value: number | null | undefined): string => (value == null ? '—' : `$${value.toFixed(2)}`);

// One decimal only where it carries information. An exact zero gains nothing from `0.0%`, and the
// extra digit made it the odd entry in columns whose other rows print whole percentages.
export const fmtPct = (value: number): string => `${value.toFixed(value === 0 || value >= 10 ? 0 : 1)}%`;

export const fmtMaybeNum = (value: number | null | undefined): string => (value == null ? '—' : fmtNum(value));

export const fmtCompact = (value: number): string => {
  if (Math.abs(value) >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (Math.abs(value) >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1e5) {
    return `${Math.round(value / 1e3)}k`;
  }
  return fmtNum(value);
};

const compactColumnFormatter = new Intl.NumberFormat('en', {
  maximumSignificantDigits: 3,
  notation: 'compact',
});

/**
 * One notation for values that are compared down a column: up to three
 * significant digits and a k/M/B suffix from 1,000 up (`999`, `1.23k`,
 * `37k`, `188k`, `10.9M`). `fmtCompact` keeps exact separators below
 * 100,000 for prose and single tiles, where nothing is compared.
 */
export const fmtCompactColumn = (value: number): string => compactColumnFormatter.format(value).replace('K', 'k');

export const fmtDate = (value: string | null): string => (value ? dateTimeFormatter.format(new Date(value)) : '—');

export const fmtDateOnly = (value: string | Date | null): string =>
  value ? dateOnlyFormatter.format(value instanceof Date ? value : new Date(value)) : '—';

export const fmtDuration = (milliseconds: number | null): string => {
  if (!milliseconds || milliseconds <= 0) {
    return '—';
  }
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  return `${(milliseconds / 3_600_000).toFixed(1)}h`;
};

export const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
