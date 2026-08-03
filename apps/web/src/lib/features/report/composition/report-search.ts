import type { FocusedOverviewRequest, FocusedReportQueryScope } from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryRequest } from '@ai-usage/report-core/session-query';
import {
  type DashboardSearch,
  parseDashboardTimeCell,
  primaryDashboardTabFor,
  sortingStateFromSearch,
} from '../../../../dashboard-search';
import { buildDashboardSessionQueryScope } from '../../../../session-query-client';
import { rangeBounds } from '../range/report-range-model';
import type { FocusedQuerySnapshot, FocusedReportDestination } from './report-destination';

export type SessionQueryScopeSnapshot = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface ReportDestinationSnapshot {
  readonly focused: FocusedReportDestination | null;
  readonly sessions: SessionQueryScopeSnapshot;
}

const scopesForSearch = (
  search: DashboardSearch,
  generatedAt: string,
): { readonly focused: FocusedQuerySnapshot; readonly sessions: SessionQueryScopeSnapshot } => {
  const bounds = rangeBounds(search.range, new Date(generatedAt));
  const localTimeCell = parseDashboardTimeCell(search.timeCell);
  const sessions = buildDashboardSessionQueryScope({
    fields: search.filters,
    harness: search.harness,
    ...(localTimeCell === undefined ? {} : { localTimeCell }),
    machine: search.machine,
    origin: search.origin,
    query: search.q,
    range: bounds,
    sorting: sortingStateFromSearch(search.sort),
  });
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
    return { focused: null, sessions: scopes.sessions };
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
