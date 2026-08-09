import { focusedBreakdownFingerprint, focusedOverviewFingerprint } from '@ai-usage/report-core/focused-report-query';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type {
  FocusedReportCommit,
  FocusedReportDescriptor,
  FocusedReportDestination,
} from '../../features/report/composition/report-destination';
import {
  destinationFingerprint,
  FocusedReportRevisionExpiredError,
  initialFocusedReportDescriptor,
  overviewRequestFor,
  requireFocusedBreakdown,
} from '../../features/report/composition/report-destination';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { currentAliasKey } from '../keys';
import { queryPolicy } from '../policies';
import type { ReportQueryClient } from './report';
import { reportBootstrapQueryOptions, reportBreakdownQueryOptions, reportOverviewQueryOptions } from './report';
import {
  ensureSessionWindow,
  initialSessionWindowIntent,
  SessionRevisionExpiredError,
  type SessionWindowIntent,
  type SessionWindowQueryData,
  sessionWindowIntentFingerprint,
} from './session-window';

export type ReportDestinationQueryKey = ReturnType<typeof currentAliasKey>;
export type ReportDestinationExactQueryKey = readonly [
  'web',
  'immutable-revision',
  'report-destination',
  revision: string,
  captureFingerprint: string,
  destinationFingerprint: string,
  sessionWindowFingerprint: string,
];

export interface ReportDestinationQueryData extends FocusedReportCommit {
  readonly sessions?: SessionWindowQueryData;
}

export interface ReportDestinationQueryExecution {
  readonly browser: boolean;
}

export interface ReportDestinationQueryDependencies {
  readonly queryClient: QueryClient;
  readonly reportClient: ReportQueryClient;
  readonly sessionClient: SessionClientAdapter;
}

export const reportDestinationKey = (): ReportDestinationQueryKey => currentAliasKey('report-destination');

export const reportDestinationExactKey = (
  destination: FocusedReportDestination,
  descriptor: FocusedReportDescriptor,
  intent: SessionWindowIntent = initialSessionWindowIntent(),
): ReportDestinationExactQueryKey => [
  'web',
  'immutable-revision',
  'report-destination',
  descriptor.revision,
  descriptor.captureFingerprint,
  destinationFingerprint(destination),
  destination.kind === 'sessions' ? sessionWindowIntentFingerprint(intent) : 'no-session-window',
];

const resultError = (result: { readonly error: { readonly message: string; readonly tag: string } }): Error =>
  result.error.tag === 'RevisionExpired' ? new FocusedReportRevisionExpiredError() : new Error(result.error.message);

const requireOverview = (
  result: Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>,
  request: Parameters<ReportQueryClient['getFocusedReportOverview']>[0],
) => {
  if (!result.ok) {
    throw resultError(result);
  }
  const fingerprint = focusedOverviewFingerprint(request);
  if (
    result.revision !== request.query.revision ||
    result.requestFingerprint !== fingerprint ||
    result.data.revision !== request.query.revision ||
    result.data.requestFingerprint !== fingerprint
  ) {
    throw new Error('The focused Overview result does not match its exact request');
  }
  return result.data;
};

const descriptorFor = async (
  dependencies: ReportDestinationQueryDependencies,
  force: boolean,
): Promise<FocusedReportDescriptor> => {
  const bootstrapOptions = reportBootstrapQueryOptions(dependencies.reportClient, { browser: true });
  if (force) {
    await dependencies.queryClient.invalidateQueries({
      exact: true,
      queryKey: bootstrapOptions.queryKey,
      refetchType: 'none',
    });
  }
  return initialFocusedReportDescriptor(await dependencies.queryClient.fetchQuery(bootstrapOptions));
};

const loadDestination = async (
  dependencies: ReportDestinationQueryDependencies,
  destination: FocusedReportDestination,
  descriptor: FocusedReportDescriptor,
  signal: AbortSignal,
  sessionWindowIntent: SessionWindowIntent,
): Promise<ReportDestinationQueryData> => {
  const overviewRequest = overviewRequestFor(destination, descriptor.revision);
  const overviewPromise = dependencies.queryClient.fetchQuery(
    reportOverviewQueryOptions(dependencies.reportClient, overviewRequest, { browser: true }),
  );
  if (destination.kind === 'overview') {
    const overview = requireOverview(await overviewPromise, overviewRequest);
    signal.throwIfAborted();
    return { descriptor, destination, overview };
  }
  if (destination.kind === 'sessions') {
    const [overviewResult, sessions] = await Promise.all([
      overviewPromise,
      ensureSessionWindow({
        client: dependencies.sessionClient,
        intent: sessionWindowIntent,
        queryClient: dependencies.queryClient,
        revision: descriptor.revision,
        scope: destination.sessions,
        signal,
      }),
    ]);
    signal.throwIfAborted();
    return {
      descriptor,
      destination,
      overview: requireOverview(overviewResult, overviewRequest),
      sessions,
    };
  }
  const breakdownRequest = {
    query: { ...destination.query, revision: descriptor.revision },
  };
  const [overviewResult, breakdownResult] = await Promise.all([
    overviewPromise,
    dependencies.queryClient.fetchQuery(
      reportBreakdownQueryOptions(dependencies.reportClient, breakdownRequest, { browser: true }),
    ),
  ]);
  signal.throwIfAborted();
  const breakdown = requireFocusedBreakdown(breakdownResult, breakdownRequest);
  if (breakdown.requestFingerprint !== focusedBreakdownFingerprint(breakdownRequest)) {
    throw new Error('The focused Breakdown projection fingerprint is invalid');
  }
  return {
    breakdown,
    descriptor,
    destination,
    overview: requireOverview(overviewResult, overviewRequest),
  };
};

const exactDestinationQueryOptions = (
  dependencies: ReportDestinationQueryDependencies,
  destination: FocusedReportDestination,
  descriptor: FocusedReportDescriptor,
  sessionWindowIntent: SessionWindowIntent,
) =>
  queryOptions({
    ...queryPolicy('immutable-revision'),
    queryFn: async ({ signal }) =>
      await loadDestination(dependencies, destination, descriptor, signal, sessionWindowIntent),
    queryKey: reportDestinationExactKey(destination, descriptor, sessionWindowIntent),
  });

export const reportDestinationQueryOptions = (
  dependencies: ReportDestinationQueryDependencies,
  destination: FocusedReportDestination,
  execution: ReportDestinationQueryExecution,
  sessionWindowIntent: SessionWindowIntent = initialSessionWindowIntent(),
) =>
  queryOptions({
    ...queryPolicy('current-alias-swr'),
    enabled: execution.browser,
    queryFn: async ({ signal }) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const descriptor = await descriptorFor(dependencies, attempt > 0);
          signal.throwIfAborted();
          const result = await dependencies.queryClient.fetchQuery(
            exactDestinationQueryOptions(dependencies, destination, descriptor, sessionWindowIntent),
          );
          signal.throwIfAborted();
          return result;
        } catch (error) {
          const expired =
            error instanceof FocusedReportRevisionExpiredError || error instanceof SessionRevisionExpiredError;
          if (!(expired && attempt === 0)) {
            throw error;
          }
        }
      }
      throw new Error('Report destination revision retry budget exhausted');
    },
    queryKey: reportDestinationKey(),
  });

export const refreshReportDestination = async (
  dependencies: ReportDestinationQueryDependencies,
  destination: FocusedReportDestination,
  sessionWindowIntent: SessionWindowIntent = initialSessionWindowIntent(),
): Promise<ReportDestinationQueryData> => {
  const options = reportDestinationQueryOptions(dependencies, destination, { browser: true }, sessionWindowIntent);
  await dependencies.queryClient.invalidateQueries({
    exact: true,
    queryKey: options.queryKey,
    refetchType: 'none',
  });
  return await dependencies.queryClient.fetchQuery(options);
};
