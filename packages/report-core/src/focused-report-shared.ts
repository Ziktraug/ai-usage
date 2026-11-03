import type { FocusedTimelineGranularity } from './focused-report-query';

export const MAX_EXECUTIVE_GROUPS = 5;
export const OTHER_EXECUTIVE_GROUP_KEY = '__ai_usage_other__';
export const MAX_TIMELINE_SERIES = 12;
export const OTHER_TIMELINE_SERIES_KEY = '__ai_usage_other__';
/**
 * How many of the aggregated tail's members the `Other` series names. The keys
 * already travel in `memberKeys`; these add a display label and totals so a
 * reader can see what the series contains. They are bounded because a
 * pathological store can push hundreds of categories into that tail.
 */
export const OTHER_MEMBER_SUMMARY_LIMIT = 10;
export const timelineGranularities = new Set<FocusedTimelineGranularity>(['day', 'month', 'week']);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

export const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};

export const assertAllowedKeys = (
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): void => {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};
