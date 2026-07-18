import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportQueryScope,
  type FocusedSupportResult,
  type FocusedTimelineDimension,
  type FocusedTimelineGranularity,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { batch } from 'solid-js';
import {
  type FocusedReportSource,
  type FocusedReportStore,
  FocusedRevisionExpiredError,
  fetchFocusedBreakdown,
  fetchFocusedOverview,
  fetchFocusedReportBootstrapDescriptor,
} from './focused-report-client';
import {
  createServedReportSession,
  type ServedReportSession,
  type ServedRevisionDescriptor,
} from './served-report-session';
import {
  type PreparedSessionQueryState,
  type SessionQueryCoordinator,
  type SessionQueryScope,
  SessionRevisionExpiredError,
} from './session-query-client';

type FocusedScopeSnapshot = Omit<FocusedReportQueryScope, 'revision'>;

interface DashboardServedDestinationBase {
  query: FocusedScopeSnapshot;
  timeline: {
    dimension: FocusedTimelineDimension;
    granularity: FocusedTimelineGranularity;
  };
}

export type DashboardServedDestination =
  | (DashboardServedDestinationBase & { includeAdvanced: boolean; kind: 'overview' })
  | (DashboardServedDestinationBase & { kind: 'breakdown' })
  | (DashboardServedDestinationBase & { kind: 'sessions'; sessions: SessionQueryScope });

interface DashboardServedRevisionDescriptor extends ServedRevisionDescriptor {
  bootstrap: FocusedSupportResult;
}

interface DashboardPreparedDestination {
  breakdown?: { request: FocusedBreakdownRequest; result: FocusedBreakdownResult };
  overview: { request: FocusedOverviewRequest; result: FocusedOverviewResult };
  sessions?: PreparedSessionQueryState;
}

const queryForRevision = (query: FocusedScopeSnapshot, revision: string): FocusedReportQueryScope => ({
  ...query,
  revision,
});

const overviewRequestFor = (destination: DashboardServedDestination, revision: string): FocusedOverviewRequest => ({
  includeAdvanced: destination.kind === 'overview' && destination.includeAdvanced,
  query: queryForRevision(destination.query, revision),
  timeline: destination.timeline,
});

export const dashboardDestinationTimelineMatches = (
  destination: DashboardServedDestination,
  revision: string,
  requestFingerprint: string | undefined,
): boolean => {
  if (!requestFingerprint) {
    return false;
  }
  const request = overviewRequestFor(destination, revision);
  return (
    requestFingerprint === focusedOverviewFingerprint({ ...request, includeAdvanced: false }) ||
    requestFingerprint === focusedOverviewFingerprint({ ...request, includeAdvanced: true })
  );
};

const destinationFingerprint = (destination: DashboardServedDestination): string => {
  const fingerprintRevision = 'destination-snapshot';
  const overview = focusedOverviewFingerprint(overviewRequestFor(destination, fingerprintRevision));
  if (destination.kind === 'breakdown') {
    return `${overview}|${focusedBreakdownFingerprint({ query: queryForRevision(destination.query, fingerprintRevision) })}`;
  }
  if (destination.kind === 'sessions') {
    return `${overview}|${sessionQueryFingerprint({
      ...destination.sessions,
      cursor: null,
      revision: fingerprintRevision,
    })}`;
  }
  return overview;
};

export const createDashboardServedReportSession = (options: {
  focusedSource: FocusedReportSource;
  focusedStore: FocusedReportStore;
  sessionCoordinator: SessionQueryCoordinator;
}): ServedReportSession<DashboardServedDestination, DashboardServedRevisionDescriptor> =>
  createServedReportSession<
    DashboardServedDestination,
    DashboardPreparedDestination,
    DashboardServedRevisionDescriptor
  >({
    acquire: async () => await fetchFocusedReportBootstrapDescriptor(options.focusedSource),
    commit: (prepared, descriptor, destination) => {
      const overviewDestination = { kind: 'overview' as const, ...prepared.overview };
      const overviewValidation = options.focusedStore.canCommitRevision(descriptor.bootstrap, overviewDestination);
      if (!overviewValidation.applied) {
        throw new Error(`Focused report destination rejected: ${overviewValidation.reason}`);
      }
      if (prepared.breakdown) {
        const currentRevisionValidation = options.focusedStore.canCommitRevision(descriptor.bootstrap, {
          kind: 'sessions',
        });
        const breakdownValidation = options.focusedStore.canApplyBreakdown(
          prepared.breakdown.request,
          prepared.breakdown.result,
          descriptor.revision,
        );
        if (!(currentRevisionValidation.applied && breakdownValidation.applied)) {
          let reason = 'revision-mismatch';
          if (!currentRevisionValidation.applied) {
            reason = currentRevisionValidation.reason;
          } else if (!breakdownValidation.applied) {
            reason = breakdownValidation.reason;
          }
          throw new Error(`Focused Breakdown rejected: ${reason}`);
        }
      }
      if (prepared.sessions && !options.sessionCoordinator.canCommitPrepared(prepared.sessions)) {
        throw new Error('The prepared Sessions destination was superseded before commit');
      }
      batch(() => {
        const overviewCommit = options.focusedStore.commitRevision(descriptor.bootstrap, overviewDestination);
        if (!overviewCommit.applied) {
          throw new Error(`Focused report destination rejected: ${overviewCommit.reason}`);
        }
        if (prepared.breakdown) {
          const breakdownCommit = options.focusedStore.applyBreakdown(
            prepared.breakdown.request,
            prepared.breakdown.result,
          );
          if (!breakdownCommit.applied) {
            throw new Error(`Focused Breakdown rejected: ${breakdownCommit.reason}`);
          }
        }
        if (prepared.sessions && !options.sessionCoordinator.commitPrepared(prepared.sessions)) {
          throw new Error('The prepared Sessions destination was superseded during commit');
        }
      });
      if (destination.kind !== 'sessions') {
        options.sessionCoordinator.select(null);
      }
    },
    destinationFingerprint,
    isRevisionExpired: (error) =>
      error instanceof FocusedRevisionExpiredError || error instanceof SessionRevisionExpiredError,
    load: async (destination, descriptor) => {
      const overviewRequest = overviewRequestFor(destination, descriptor.revision);
      const overviewPromise = fetchFocusedOverview(options.focusedSource, overviewRequest);
      if (destination.kind === 'breakdown') {
        const breakdownRequest: FocusedBreakdownRequest = {
          query: queryForRevision(destination.query, descriptor.revision),
        };
        const [overviewResult, breakdownResult] = await Promise.all([
          overviewPromise,
          fetchFocusedBreakdown(options.focusedSource, breakdownRequest),
        ]);
        return {
          breakdown: { request: breakdownRequest, result: breakdownResult },
          overview: { request: overviewRequest, result: overviewResult },
        };
      }
      if (destination.kind === 'sessions') {
        const [overviewResult, sessions] = await Promise.all([
          overviewPromise,
          options.sessionCoordinator.prepare(destination.sessions, descriptor.revision),
        ]);
        return {
          overview: { request: overviewRequest, result: overviewResult },
          sessions,
        };
      }
      return {
        overview: { request: overviewRequest, result: await overviewPromise },
      };
    },
  });
