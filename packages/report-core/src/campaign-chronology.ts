import { isStrictIsoTimestamp } from './serialized-usage-validation';

export interface CampaignChronology {
  endedAt: string | null;
  /** First observed anchor, including an end timestamp when its start is absent. */
  observedFrom: string | null;
  /** Last observed anchor, including a start timestamp when its end is absent. */
  observedTo: string | null;
  sessionCount: number;
  startedAt: string | null;
  /** Members with both timestamps in chronological order; zero-length intervals qualify. */
  timedSessionCount: number;
}

export interface CampaignTimingRow {
  date: string | null;
  endDate: string | null;
}

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());
const minimum = (current: number | null, next: number): number => (current === null ? next : Math.min(current, next));
const maximum = (current: number | null, next: number): number => (current === null ? next : Math.max(current, next));

/** Full-campaign observed chronology, independent of discovery filters and active-duration metrics. */
export const buildCampaignChronology = (rows: Iterable<CampaignTimingRow>): CampaignChronology => {
  let sessionCount = 0;
  let timedSessionCount = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let observedFrom: number | null = null;
  let observedTo: number | null = null;
  for (const row of rows) {
    sessionCount += 1;
    if (
      (row.date !== null && !isStrictIsoTimestamp(row.date)) ||
      (row.endDate !== null && !isStrictIsoTimestamp(row.endDate))
    ) {
      continue;
    }
    const start = row.date === null ? null : Date.parse(row.date);
    const end = row.endDate === null ? null : Date.parse(row.endDate);
    if (start !== null && end !== null) {
      if (end < start) {
        continue;
      }
      timedSessionCount += 1;
    }
    if (start !== null) {
      startedAt = minimum(startedAt, start);
      observedFrom = minimum(observedFrom, start);
      observedTo = maximum(observedTo, start);
    }
    if (end !== null) {
      endedAt = maximum(endedAt, end);
      observedFrom = minimum(observedFrom, end);
      observedTo = maximum(observedTo, end);
    }
  }
  return {
    endedAt: iso(endedAt),
    observedFrom: iso(observedFrom),
    observedTo: iso(observedTo),
    sessionCount,
    startedAt: iso(startedAt),
    timedSessionCount,
  };
};
