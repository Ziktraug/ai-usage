import type { DehydratedState } from '@tanstack/svelte-query';
import type { WebQueryHydrationState } from '../../query/client';

export type ReportHydrationQueryFamily =
  | 'bootstrap'
  | 'destination-current'
  | 'destination-exact'
  | 'other'
  | 'overview'
  | 'session-pages';

export interface ReportHydrationFamilyBytes {
  readonly bytes: number;
  readonly queryCount: number;
}

export interface ReportHydrationByteSnapshot {
  readonly families: Record<ReportHydrationQueryFamily, ReportHydrationFamilyBytes>;
  readonly totalBytes: number;
}

const EMPTY_FAMILY: ReportHydrationFamilyBytes = { bytes: 0, queryCount: 0 };
const textEncoder = new TextEncoder();

const emptyFamilies = (): Record<ReportHydrationQueryFamily, ReportHydrationFamilyBytes> => ({
  bootstrap: { ...EMPTY_FAMILY },
  'destination-current': { ...EMPTY_FAMILY },
  'destination-exact': { ...EMPTY_FAMILY },
  other: { ...EMPTY_FAMILY },
  overview: { ...EMPTY_FAMILY },
  'session-pages': { ...EMPTY_FAMILY },
});

let latestHydrationBytes: ReportHydrationByteSnapshot = {
  families: emptyFamilies(),
  totalBytes: 0,
};

export const reportHydrationPerfEnabled = (): boolean =>
  typeof process !== 'undefined' && (process.env.AI_USAGE_PERF === '1' || process.env.AI_USAGE_PERF === 'true');

const classifyQueryFamily = (queryKey: readonly unknown[]): ReportHydrationQueryFamily => {
  const family = typeof queryKey[2] === 'string' ? queryKey[2] : '';
  const leaf = typeof queryKey.at(-1) === 'string' ? queryKey.at(-1) : '';
  if (family === 'report-bootstrap') {
    return 'bootstrap';
  }
  if (family === 'session-pages') {
    return 'session-pages';
  }
  if (family === 'report-destination' && queryKey[1] === 'current-alias') {
    return 'destination-current';
  }
  if (family === 'report-destination') {
    return 'destination-exact';
  }
  if (family === 'report' && leaf === 'overview') {
    return 'overview';
  }
  return 'other';
};

const queryBytes = (query: DehydratedState['queries'][number]): number =>
  textEncoder.encode(JSON.stringify(query)).byteLength;

export const recordReportHydrationBytes = (state: WebQueryHydrationState): void => {
  if (!reportHydrationPerfEnabled()) {
    return;
  }
  const families = emptyFamilies();
  let totalBytes = 0;
  for (const query of state.dehydratedState.queries) {
    const bytes = queryBytes(query);
    totalBytes += bytes;
    const family = classifyQueryFamily(query.queryKey as readonly unknown[]);
    const current = families[family];
    families[family] = {
      bytes: current.bytes + bytes,
      queryCount: current.queryCount + 1,
    };
  }
  latestHydrationBytes = { families, totalBytes };
};

export const snapshotReportHydrationBytes = (): ReportHydrationByteSnapshot => latestHydrationBytes;

export const resetReportHydrationBytes = (): void => {
  latestHydrationBytes = { families: emptyFamilies(), totalBytes: 0 };
};
