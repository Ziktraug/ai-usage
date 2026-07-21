import { focusedAdvancedAnalysisFingerprint } from '@ai-usage/report-core/focused-report-query';
import { type Accessor, batch, createEffect, createSignal, onCleanup } from 'solid-js';
import {
  type DashboardServedDestination,
  dashboardDestinationTimelineMatches,
} from './dashboard-served-report-session';
import type { ServedReportSession, ServedRevisionDescriptor } from './served-report-session';
import type { SessionQueryCoordinator, SessionQueryState } from './session-query-client';

type DashboardReportQueryScope = DashboardServedDestination['query'];
type DashboardReportTimeline = DashboardServedDestination['timeline'];

export type DashboardReportDestinationScope =
  | { kind: 'overview'; query: DashboardReportQueryScope }
  | { kind: 'breakdown'; query: DashboardReportQueryScope }
  | {
      kind: 'sessions';
      query: DashboardReportQueryScope;
      sessions: Extract<DashboardServedDestination, { kind: 'sessions' }>['sessions'];
    };

interface AdvancedAnalysisFailure {
  message: string;
  scopeFingerprint: string;
}

export interface DashboardReportLifecycleOptions {
  currentOverviewRequestFingerprint: Accessor<string | undefined>;
  currentRevision: Accessor<string>;
  destinationScope: Accessor<DashboardReportDestinationScope | undefined>;
  onError: (message: string) => void;
  publicationRevision: Accessor<string | undefined>;
  ready: Accessor<boolean>;
  servedReportSession?: ServedReportSession<DashboardServedDestination, ServedRevisionDescriptor>;
  sessionCoordinator?: Pick<SessionQueryCoordinator, 'close'>;
  sessionState: Accessor<SessionQueryState | undefined>;
}

export interface DashboardReportLifecycle {
  advancedAnalysisError: Accessor<string | null>;
  advancedAnalysisLoading: Accessor<boolean>;
  available: boolean;
  focusedTimelineError: Accessor<string | null>;
  focusedTimelineLoading: Accessor<boolean>;
  refresh: () => Promise<void>;
  requestTimeline: (timeline: DashboardReportTimeline) => void;
  sessionQueryLoading: Accessor<boolean>;
}

const DEFAULT_TIMELINE: DashboardReportTimeline = { dimension: 'harness', granularity: 'day' };

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

export const transitionDashboardPublication = (
  observedRevision: string | undefined,
  publicationRevision: string | undefined,
  ready: boolean,
  currentRevision: string,
): { observedRevision: string | undefined; refresh: boolean } => {
  if (!publicationRevision || publicationRevision === observedRevision) {
    return { observedRevision, refresh: false };
  }
  return {
    observedRevision: publicationRevision,
    refresh: ready && currentRevision !== publicationRevision,
  };
};

export const createDashboardReportLifecycle = (options: DashboardReportLifecycleOptions): DashboardReportLifecycle => {
  const available = options.servedReportSession !== undefined;
  const [timeline, setTimeline] = createSignal<DashboardReportTimeline>(DEFAULT_TIMELINE);
  const [advancedAnalysisFailure, setAdvancedAnalysisFailure] = createSignal<AdvancedAnalysisFailure>();
  const [advancedAnalysisLoading, setAdvancedAnalysisLoading] = createSignal(false);
  const [focusedTimelineError, setFocusedTimelineError] = createSignal<string | null>(null);
  const [focusedTimelineLoading, setFocusedTimelineLoading] = createSignal(available);
  const [sessionQueryLoading, setSessionQueryLoading] = createSignal(false);
  let disposed = false;

  const advancedScopeFingerprint = (scope: DashboardReportQueryScope): string =>
    focusedAdvancedAnalysisFingerprint({ ...scope, revision: options.currentRevision() });

  const destination = (): DashboardServedDestination | undefined => {
    const scope = options.destinationScope();
    if (!scope) {
      return;
    }
    const currentTimeline = timeline();
    if (scope.kind === 'overview') {
      const scopeFingerprint = advancedScopeFingerprint(scope.query);
      return {
        includeAdvanced: advancedAnalysisFailure()?.scopeFingerprint !== scopeFingerprint,
        kind: 'overview',
        query: scope.query,
        timeline: currentTimeline,
      };
    }
    if (scope.kind === 'breakdown') {
      return { ...scope, timeline: currentTimeline };
    }
    return { ...scope, timeline: currentTimeline };
  };

  const advancedAnalysisError = (): string | null => {
    const scope = options.destinationScope();
    const failure = advancedAnalysisFailure();
    if (!(scope?.kind === 'overview' && failure)) {
      return null;
    }
    return failure.scopeFingerprint === advancedScopeFingerprint(scope.query) ? failure.message : null;
  };

  const markLoading = (nextDestination: DashboardServedDestination): void => {
    batch(() => {
      setFocusedTimelineLoading(
        !dashboardDestinationTimelineMatches(
          nextDestination,
          options.currentRevision(),
          options.currentOverviewRequestFingerprint(),
        ),
      );
      setAdvancedAnalysisLoading(nextDestination.kind === 'overview' && nextDestination.includeAdvanced);
      setSessionQueryLoading(nextDestination.kind === 'sessions' && !options.sessionState());
    });
  };

  const refreshDestination = async (
    nextDestination: DashboardServedDestination,
    thrownErrorFallback: string,
  ): Promise<void> => {
    const servedReportSession = options.servedReportSession;
    if (!(servedReportSession && !disposed)) {
      return;
    }

    let outcome: Awaited<ReturnType<typeof servedReportSession.refresh>>;
    try {
      outcome = await servedReportSession.refresh(nextDestination);
    } catch (error) {
      if (!disposed) {
        options.onError(errorMessage(error, thrownErrorFallback));
      }
      return;
    }
    if (disposed || outcome.status === 'superseded') {
      return;
    }
    if (outcome.status === 'failed-preserving-previous') {
      const message = errorMessage(outcome.error, 'Failed to load report destination');
      setFocusedTimelineError(message);
      options.onError(message);
      if (nextDestination.kind === 'overview' && nextDestination.includeAdvanced) {
        setAdvancedAnalysisFailure({
          message,
          scopeFingerprint: advancedScopeFingerprint(nextDestination.query),
        });
      }
      return;
    }

    batch(() => {
      setFocusedTimelineError(null);
      setFocusedTimelineLoading(false);
      setAdvancedAnalysisLoading(false);
      setSessionQueryLoading(false);
      if (nextDestination.kind === 'overview' && nextDestination.includeAdvanced) {
        setAdvancedAnalysisFailure(undefined);
      }
    });
  };

  const refresh = async (): Promise<void> => {
    const nextDestination = destination();
    if (!(options.ready() && nextDestination && available && !disposed)) {
      return;
    }
    await refreshDestination(nextDestination, 'Failed to coordinate report destination');
  };

  createEffect(() => {
    const isReady = options.ready();
    const nextDestination = destination();
    if (!(isReady && nextDestination && available && !disposed)) {
      return;
    }
    markLoading(nextDestination);
    refreshDestination(nextDestination, 'Failed to coordinate report destination').catch((error: unknown) => {
      if (!disposed) {
        options.onError(errorMessage(error, 'Failed to coordinate report destination'));
      }
    });
  });

  let observedPublicationRevision: string | undefined;
  createEffect(() => {
    const revision = options.publicationRevision();
    const transition = transitionDashboardPublication(
      observedPublicationRevision,
      revision,
      options.ready(),
      options.currentRevision(),
    );
    observedPublicationRevision = transition.observedRevision;
    if (!transition.refresh) {
      return;
    }
    const nextDestination = destination();
    if (!(nextDestination && available && !disposed)) {
      return;
    }
    refreshDestination(nextDestination, 'Published report data could not be loaded').catch((error: unknown) => {
      if (!disposed) {
        options.onError(errorMessage(error, 'Published report data could not be loaded'));
      }
    });
  });

  const requestTimeline = (nextTimeline: DashboardReportTimeline): void => {
    if (!available || disposed) {
      return;
    }
    batch(() => {
      setFocusedTimelineLoading(true);
      setTimeline(nextTimeline);
    });
  };

  onCleanup(() => {
    if (disposed) {
      return;
    }
    disposed = true;
    options.servedReportSession?.abort();
    options.sessionCoordinator?.close();
  });

  return {
    advancedAnalysisError,
    advancedAnalysisLoading,
    available,
    focusedTimelineError,
    focusedTimelineLoading,
    refresh,
    requestTimeline,
    sessionQueryLoading,
  };
};
