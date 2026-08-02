const timeZoneFormatterCache = new Map<string, Intl.DateTimeFormat>();
const weekdayByShortLabel = new Map([
  ['Mon', 0],
  ['Tue', 1],
  ['Wed', 2],
  ['Thu', 3],
  ['Fri', 4],
  ['Sat', 5],
  ['Sun', 6],
] as const);

const formatterForTimeZone = (timeZone: string): Intl.DateTimeFormat => {
  const cached = timeZoneFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
    weekday: 'short',
  });
  timeZoneFormatterCache.set(timeZone, formatter);
  return formatter;
};

export const parseReportTimeZone = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Report time zone must be a non-empty canonical IANA time zone');
  }
  try {
    return formatterForTimeZone(value).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Report time zone is invalid: ${value}`);
  }
};

export const isReportTimeZone = (value: unknown): value is string => {
  try {
    return parseReportTimeZone(value) === value;
  } catch {
    return false;
  }
};

export const systemReportTimeZone = (): string =>
  parseReportTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

export interface ZonedWeekdayHour {
  hour: number;
  weekday: number;
}

export const zonedWeekdayHourForTimestamp = (timestamp: number, timeZone: string): ZonedWeekdayHour => {
  if (!Number.isFinite(timestamp)) {
    throw new Error('Cannot derive zoned time fields from an invalid timestamp');
  }
  const parts = formatterForTimeZone(parseReportTimeZone(timeZone)).formatToParts(timestamp);
  const hour = Number(parts.find(({ type }) => type === 'hour')?.value);
  const weekdayLabel = parts.find(({ type }) => type === 'weekday')?.value;
  const weekday = weekdayByShortLabel.get(weekdayLabel as 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun');
  if (!(Number.isInteger(hour) && hour >= 0 && hour <= 23 && weekday !== undefined)) {
    throw new Error('Cannot derive zoned time fields from the requested timestamp');
  }
  return { hour, weekday };
};
