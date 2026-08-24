import type { FocusedOverviewRequest, FocusedReportQueryScope } from '@ai-usage/report-core/focused-report-query';
import {
  isSessionSortField,
  parseSessionQueryRequest,
  type SessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import {
  type DashboardDateRangeSearch,
  type DashboardSearch,
  parseDashboardTimeCell,
  primaryDashboardTabFor,
  sortingStateFromSearch,
} from '../../../../dashboard-search';
import { rangeBounds, reportRangeProjection, resolveTimelineGranularity } from '../range/report-range-model';
import {
  type FocusedQuerySnapshot,
  type FocusedReportDestination,
  INITIAL_REPORT_TIMELINE,
} from './report-destination';

export type SessionQueryScopeSnapshot = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface ReportDestinationSnapshot {
  readonly focused: FocusedReportDestination | null;
  readonly sessions: SessionQueryScopeSnapshot;
}

export const SERVED_SESSION_PAGE_SIZE = 200;

export const initialReportTimelineFor = (
  range: DashboardDateRangeSearch,
  generatedAt: string,
): FocusedOverviewRequest['timeline'] => ({
  dimension: INITIAL_REPORT_TIMELINE.dimension,
  granularity: resolveTimelineGranularity('auto', reportRangeProjection(range, new Date(generatedAt), null).dayCount),
});

export const reportFilterFingerprint = (filters: FocusedQuerySnapshot['filters']): string => JSON.stringify(filters);

const canonicalDate = (value: Date | null): string | null => {
  if (value === null) {
    return null;
  }
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Session query date bounds must be valid dates');
  }
  return new Date(time).toISOString();
};

const scopesForSearch = (
  search: DashboardSearch,
  generatedAt: string,
): { readonly focused: FocusedQuerySnapshot; readonly sessions: SessionQueryScopeSnapshot } => {
  const bounds = rangeBounds(search.range, new Date(generatedAt));
  const localTimeCell = parseDashboardTimeCell(search.timeCell);
  const sort = sortingStateFromSearch(search.sort).map(({ desc, id }) => {
    if (!isSessionSortField(id)) {
      throw new Error(`Unsupported session sort field: ${id}`);
    }
    return { desc, id };
  });
  const validated = parseSessionQueryRequest({
    cursor: null,
    filters: {
      fields: search.filters,
      harness: search.harness,
      ...(localTimeCell === undefined ? {} : { localTimeCell }),
      machine: search.machine,
      origin: search.origin,
      query: search.q,
    },
    pageSize: SERVED_SESSION_PAGE_SIZE,
    range: { from: canonicalDate(bounds.from), to: canonicalDate(bounds.to) },
    revision: 'pending-revision',
    sort: sort.length > 0 ? sort : [{ desc: true, id: 'date' }],
  });
  const { cursor: _cursor, revision: _revision, ...sessions } = validated;
  const focused: FocusedQuerySnapshot = {
    filters: sessions.filters,
    range: sessions.range,
  };
  return { focused, sessions };
};

export const reportDestinationForSearch = (
  search: DashboardSearch,
  generatedAt: string,
  timeline: FocusedOverviewRequest['timeline'],
): ReportDestinationSnapshot => {
  const scopes = scopesForSearch(search, generatedAt);
  const primary = primaryDashboardTabFor(search.tab);
  if (primary === 'sessions') {
    return {
      focused: { kind: 'sessions', query: scopes.focused, sessions: scopes.sessions, timeline },
      sessions: scopes.sessions,
    };
  }
  return {
    focused:
      primary === 'overview'
        ? { includeAdvanced: true, kind: 'overview', query: scopes.focused, timeline }
        : { kind: 'breakdown', query: scopes.focused, timeline },
    sessions: scopes.sessions,
  };
};

export const queryForDescriptor = (query: FocusedQuerySnapshot, revision: string): FocusedReportQueryScope => ({
  ...query,
  revision,
});
