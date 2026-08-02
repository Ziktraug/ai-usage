import type { FocusedReportQueryScope } from '@ai-usage/report-core/focused-report-query';
import type { DashboardReportDestinationScope } from './dashboard-report-lifecycle';
import { type DashboardTab, primaryDashboardTabFor } from './dashboard-search';
import type { SessionQueryScope } from './session-query-client';

export const buildDashboardReportDestinationScope = (
  tab: DashboardTab,
  focusedQuery: FocusedReportQueryScope,
  sessions: SessionQueryScope,
): DashboardReportDestinationScope => {
  const { revision: _revision, ...query } = focusedQuery;
  const destination = primaryDashboardTabFor(tab);
  if (destination === 'sessions') {
    return { kind: 'sessions', query, sessions };
  }
  return { kind: destination, query };
};
