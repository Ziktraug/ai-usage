import type { FocusedDateDomain } from '@ai-usage/report-core/focused-report-query';
import type { DashboardSearch } from '../../../../dashboard-search';
import type { TimelineDimension } from '../../../../overview-model';
import { parseDashboardSearchUrl } from '../../../foundation/navigation/svelte/dashboard-url';
import { initialSessionWindowIntent, type SessionWindowIntent } from '../../../query/options/session-window';
import { sessionRouteFor } from '../../sessions/detail/session-route';
import { dashboardSearchCodec } from '../../shell/navigation';
import {
  reportRangeProjection,
  resolveTimelineGranularity,
  type TimelineGranularityPreference,
} from '../range/report-range-model';
import { destinationFingerprint, type FocusedReportDestination } from './report-destination';
import { reportDestinationForSearch } from './report-search';

export interface ReportTimelineState {
  readonly dimension: TimelineDimension;
  readonly granularityPreference: TimelineGranularityPreference;
  readonly knownDateDomain: FocusedDateDomain | null;
}

export interface ReportSessionWindowState {
  readonly destinationFingerprint: string;
  readonly intent: SessionWindowIntent;
}

export const reportTimelineForSearch = (search: DashboardSearch, generatedAt: string, state: ReportTimelineState) => ({
  dimension: state.dimension,
  granularity: resolveTimelineGranularity(
    state.granularityPreference,
    reportRangeProjection(search.range, new Date(generatedAt), state.knownDateDomain).dayCount,
  ),
});

export const reportSessionIntentFor = (
  destination: FocusedReportDestination,
  state: ReportSessionWindowState,
): SessionWindowIntent =>
  destination.kind === 'sessions' && state.destinationFingerprint === destinationFingerprint(destination)
    ? state.intent
    : initialSessionWindowIntent();

export const reportPreservesSessionRevision = (
  destination: FocusedReportDestination,
  intent: SessionWindowIntent,
  detailRouteOpen: boolean,
  pendingRevisionApply: boolean,
): boolean =>
  detailRouteOpen ||
  (destination.kind === 'sessions' &&
    (pendingRevisionApply || intent.topLevelDepth > 1 || Object.keys(intent.campaignChildrenDepth).length > 0));

export interface ReportTabIntentTarget {
  readonly destination: FocusedReportDestination;
  readonly preserveSessionRevision: boolean;
  readonly sessionWindowIntent: SessionWindowIntent;
}

export const reportTabTargetFor = (
  url: URL,
  state: ReportTimelineState & {
    readonly generatedAt: string;
    readonly sessionWindowState: ReportSessionWindowState;
    readonly pendingRevisionApply: boolean;
  },
): ReportTabIntentTarget | null => {
  const search = parseDashboardSearchUrl(url, dashboardSearchCodec);
  const destination = reportDestinationForSearch(
    search,
    state.generatedAt,
    reportTimelineForSearch(search, state.generatedAt, state),
  ).focused;
  if (!destination) {
    return null;
  }
  const sessionWindowIntent = reportSessionIntentFor(destination, state.sessionWindowState);
  return {
    destination,
    sessionWindowIntent,
    preserveSessionRevision: reportPreservesSessionRevision(
      destination,
      sessionWindowIntent,
      sessionRouteFor(url.pathname) !== null,
      state.pendingRevisionApply,
    ),
  };
};
