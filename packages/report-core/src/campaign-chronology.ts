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

export interface CampaignChronologyAccumulator {
  add(row: CampaignTimingRow): void;
  finish(): CampaignChronology;
}

/** Keeps only the observed bounds and counts while a campaign's members stream past. */
export const createCampaignChronologyAccumulator = (): CampaignChronologyAccumulator => {
  let sessionCount = 0;
  let timedSessionCount = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let observedFrom: number | null = null;
  let observedTo: number | null = null;
  const add = (row: CampaignTimingRow): void => {
    sessionCount += 1;
    if (
      (row.date !== null && !isStrictIsoTimestamp(row.date)) ||
      (row.endDate !== null && !isStrictIsoTimestamp(row.endDate))
    ) {
      return;
    }
    const start = row.date === null ? null : Date.parse(row.date);
    const end = row.endDate === null ? null : Date.parse(row.endDate);
    if (start !== null && end !== null) {
      if (end < start) {
        return;
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
  };
  return {
    add,
    finish: () => ({
      endedAt: iso(endedAt),
      observedFrom: iso(observedFrom),
      observedTo: iso(observedTo),
      sessionCount,
      startedAt: iso(startedAt),
      timedSessionCount,
    }),
  };
};

/** Full-campaign observed chronology, independent of discovery filters and active-duration metrics. */
export const buildCampaignChronology = (rows: Iterable<CampaignTimingRow>): CampaignChronology => {
  const accumulator = createCampaignChronologyAccumulator();
  for (const row of rows) {
    accumulator.add(row);
  }
  return accumulator.finish();
};
