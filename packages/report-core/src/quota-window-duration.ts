declare const quotaWindowDurationBrand: unique symbol;

export type QuotaWindowDuration = number & {
  readonly [quotaWindowDurationBrand]: 'QuotaWindowDuration';
};

export type QuotaWindowGroup = '5h' | 'monthly' | 'weekly';

export const quotaWindowDurationFromSeconds = (value: unknown): QuotaWindowDuration | null => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? (seconds as QuotaWindowDuration) : null;
};

export const quotaWindowDurationFromMinutes = (value: unknown): QuotaWindowDuration | null => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? ((minutes * 60) as QuotaWindowDuration) : null;
};

export const quotaWindowGroup = (duration: QuotaWindowDuration | null): QuotaWindowGroup | null => {
  if (duration === 18_000) {
    return '5h';
  }
  if (duration === 604_800) {
    return 'weekly';
  }
  if (duration !== null && duration >= 2_419_200 && duration <= 2_678_400) {
    return 'monthly';
  }
  return null;
};

export const quotaWindowLabel = (duration: QuotaWindowDuration | null, fallback = 'Quota window'): string => {
  if (duration === null) {
    return fallback;
  }
  const hours = duration / 3600;
  if (hours === 5) {
    return '5h';
  }
  const days = duration / 86_400;
  if (days === 7) {
    return 'Weekly';
  }
  if (days >= 28 && days <= 31) {
    return 'Monthly';
  }
  if (Number.isInteger(hours) && hours < 24) {
    return `${hours}h`;
  }
  if (Number.isInteger(days)) {
    return `${days}d`;
  }
  return fallback;
};
