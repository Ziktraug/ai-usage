import { overviewRequestFor } from '../features/report/composition/report-destination';
import { reportBreakdownKey, reportOverviewKey } from './options/report';
import {
  type ReportDestinationQueryData,
  type ReportDestinationQueryDependencies,
  reportDestinationExactKey,
} from './options/report-destination';
import { type SessionWindowIntent, sessionCampaignInfiniteOptions, sessionPagesKey } from './options/session-window';

/** Reset only entries owned by the failed visible region, never another revision or destination. */
export const resetReportRegionQueries = async (
  dependencies: ReportDestinationQueryDependencies,
  commit: ReportDestinationQueryData,
  intent: SessionWindowIntent,
  region: 'overview' | 'panel',
): Promise<void> => {
  const { queryClient, sessionClient } = dependencies;
  const keys = [reportDestinationExactKey(commit.destination, commit.descriptor, intent)];
  const reset = (queryKey: readonly unknown[]) =>
    queryClient.resetQueries({ exact: true, queryKey }, { throwOnError: true });
  const reads: Promise<void>[] = [];
  if (region === 'overview') {
    reads.push(reset(reportOverviewKey(overviewRequestFor(commit.destination, commit.descriptor.revision))));
  } else if (commit.destination.kind === 'breakdown') {
    reads.push(
      reset(reportBreakdownKey({ query: { ...commit.destination.query, revision: commit.descriptor.revision } })),
    );
  } else if (commit.sessions) {
    reads.push(reset(sessionPagesKey(commit.sessions.query)));
    for (const [family, windows] of [
      ['campaign-children', commit.sessions.campaignChildren],
      ['campaign-sessions', commit.sessions.campaignSessions],
    ] as const) {
      for (const window of windows) {
        reads.push(
          reset(
            sessionCampaignInfiniteOptions(sessionClient, commit.sessions.query, window.campaignKey, family).queryKey,
          ),
        );
      }
    }
  }
  await Promise.all([...reads, ...keys.map(reset)]);
};
