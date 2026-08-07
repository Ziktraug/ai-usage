import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportQueryScope,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import type { QueryClient, QueryKey } from '@tanstack/svelte-query';
import {
  createServedReportSession,
  type ServedReportSession,
  type ServedRevisionDescriptor,
} from '../../../../served-report-session';
import {
  type ReportQueryClient,
  reportBootstrapQueryOptions,
  reportBreakdownKey,
  reportBreakdownQueryOptions,
  reportOverviewKey,
  reportOverviewQueryOptions,
} from '../../../query/options/report';
import type {
  PreparedSessionTableQuery,
  SessionTableQueryOwner,
  SessionTableQueryScope,
} from '../../sessions/table/session-table-query-owner';
import { SessionTableRevisionExpiredError } from '../../sessions/table/session-table-query-owner';

export type FocusedQuerySnapshot = Omit<FocusedReportQueryScope, 'revision'>;

export type FocusedReportDestination =
  | {
      readonly includeAdvanced: boolean;
      readonly kind: 'overview';
      readonly query: FocusedQuerySnapshot;
      readonly timeline: FocusedOverviewRequest['timeline'];
    }
  | {
      readonly kind: 'breakdown';
      readonly query: FocusedQuerySnapshot;
      readonly timeline: FocusedOverviewRequest['timeline'];
    }
  | {
      readonly kind: 'sessions';
      readonly query: FocusedQuerySnapshot;
      readonly sessions: SessionTableQueryScope;
      readonly timeline: FocusedOverviewRequest['timeline'];
    };

export interface FocusedReportDescriptor extends ServedRevisionDescriptor {
  readonly bootstrap: Extract<ReportRevisionBootstrapResult, { readonly ok: true }>['bootstrap'];
}

export interface FocusedReportCommit {
  readonly breakdown?: FocusedBreakdownResult;
  readonly descriptor: FocusedReportDescriptor;
  readonly destination: FocusedReportDestination;
  readonly overview: FocusedOverviewResult;
}

export interface FocusedReportDescriptorSource {
  readonly acquire: (signal: AbortSignal, force: boolean) => Promise<FocusedReportDescriptor>;
  readonly current: () => FocusedReportDescriptor;
}

interface PreparedFocusedReport {
  readonly breakdown?: FocusedBreakdownResult;
  readonly overview: FocusedOverviewResult;
  readonly sessions?: PreparedSessionTableQuery;
}

export class FocusedReportRevisionExpiredError extends Error {
  constructor() {
    super('The exact focused report revision expired');
    this.name = 'FocusedReportRevisionExpiredError';
  }
}

const descriptorFromBootstrap = (result: ReportRevisionBootstrapResult): FocusedReportDescriptor => {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const { bootstrap, manifest } = result;
  const expectedSupportFingerprint = focusedRevisionFingerprint('support', { revision: manifest.revision });
  if (
    bootstrap.revision !== manifest.revision ||
    bootstrap.requestFingerprint !== expectedSupportFingerprint ||
    !manifest.captureFingerprint
  ) {
    throw new Error('The report bootstrap identity does not match its publication manifest');
  }
  return {
    bootstrap,
    captureFingerprint: manifest.captureFingerprint,
    revision: manifest.revision,
  };
};

export const initialFocusedReportDescriptor = (result: ReportRevisionBootstrapResult): FocusedReportDescriptor =>
  descriptorFromBootstrap(result);

export const createFocusedReportDescriptorSource = (options: {
  readonly client: ReportQueryClient;
  readonly initial: FocusedReportDescriptor;
  readonly queryClient: QueryClient;
}): FocusedReportDescriptorSource => {
  let current = options.initial;
  let useInitial = true;
  return {
    acquire: async (signal, force) => {
      if (useInitial && !force) {
        useInitial = false;
        return current;
      }
      useInitial = false;
      const query = reportBootstrapQueryOptions(options.client, { browser: true });
      if (force) {
        await options.queryClient.invalidateQueries({ exact: true, queryKey: query.queryKey, refetchType: 'none' });
      }
      current = descriptorFromBootstrap(
        await readExactQuery<ReportRevisionBootstrapResult>(options.queryClient, query, signal),
      );
      return current;
    },
    current: () => current,
  };
};

const queryForRevision = (query: FocusedQuerySnapshot, revision: string): FocusedReportQueryScope => ({
  ...query,
  revision,
});

export const overviewRequestFor = (
  destination: FocusedReportDestination,
  revision: string,
): FocusedOverviewRequest => ({
  includeAdvanced: destination.kind === 'overview' && destination.includeAdvanced,
  query: queryForRevision(destination.query, revision),
  timeline: destination.timeline,
});

/**
 * Timeline the report opens on. Shared by the server prefetch and the hydrated component so both
 * derive the same Overview request fingerprint — a mismatch would silently miss the seeded cache.
 */
export const INITIAL_REPORT_TIMELINE: FocusedOverviewRequest['timeline'] = Object.freeze({
  dimension: 'harness',
  granularity: 'day',
});

const destinationFingerprint = (destination: FocusedReportDestination): string => {
  const revision = 'destination-snapshot';
  const overview = focusedOverviewFingerprint(overviewRequestFor(destination, revision));
  if (destination.kind === 'overview') {
    return overview;
  }
  if (destination.kind === 'sessions') {
    return `${overview}|${sessionQueryFingerprint({ ...destination.sessions, cursor: null, revision })}`;
  }
  return `${overview}|${focusedBreakdownFingerprint({ query: queryForRevision(destination.query, revision) })}`;
};

const linkAbort = (signal: AbortSignal, queryClient: QueryClient, queryKey: QueryKey): (() => void) => {
  const cancel = (): void => {
    queryClient.cancelQueries({ exact: true, queryKey }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
};

const readExactQuery = async <Value>(
  queryClient: QueryClient,
  query: { readonly queryKey: QueryKey; readonly queryFn?: unknown },
  signal: AbortSignal,
): Promise<Value> => {
  const unlink = linkAbort(signal, queryClient, query.queryKey);
  try {
    return (await queryClient.fetchQuery(query as Parameters<QueryClient['fetchQuery']>[0])) as Value;
  } finally {
    unlink();
  }
};

const resultError = (result: { readonly error: { readonly message: string; readonly tag: string } }): Error =>
  result.error.tag === 'RevisionExpired' ? new FocusedReportRevisionExpiredError() : new Error(result.error.message);

const requireOverview = (
  result: Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>,
  request: FocusedOverviewRequest,
): FocusedOverviewResult => {
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

export const requireFocusedBreakdown = (
  result: Awaited<ReturnType<ReportQueryClient['getFocusedReportBreakdown']>>,
  request: FocusedBreakdownRequest,
): FocusedBreakdownResult => {
  if (!result.ok) {
    throw resultError(result);
  }
  const fingerprint = focusedBreakdownFingerprint(request);
  if (
    result.revision !== request.query.revision ||
    result.requestFingerprint !== fingerprint ||
    result.data.revision !== request.query.revision ||
    result.data.requestFingerprint !== fingerprint
  ) {
    throw new Error('The focused Breakdown result does not match its exact request');
  }
  return result.data;
};

/**
 * Rebuilds the first visible commit straight from an already-populated query cache, with no await.
 * The async session below stays the sole owner of every *subsequent* commit; this only lets the
 * server — and the hydrating client — adopt the exact destination data instead of a pending surface.
 * Returns undefined whenever the cache cannot satisfy the destination exactly, so the normal
 * asynchronous path takes over unchanged.
 */
export const seedFocusedReportCommit = (options: {
  readonly descriptor: FocusedReportDescriptor;
  readonly destination: FocusedReportDestination | null;
  readonly queryClient: QueryClient;
}): FocusedReportCommit | undefined => {
  if (options.destination === null) {
    return;
  }
  const request = overviewRequestFor(options.destination, options.descriptor.revision);
  const cached = options.queryClient.getQueryData(reportOverviewKey(request));
  if (cached === undefined) {
    return;
  }
  try {
    if (options.destination.kind === 'breakdown') {
      const breakdownRequest: FocusedBreakdownRequest = {
        query: queryForRevision(options.destination.query, options.descriptor.revision),
      };
      const breakdown = options.queryClient.getQueryData(reportBreakdownKey(breakdownRequest));
      if (breakdown === undefined) {
        return;
      }
      return {
        breakdown: requireFocusedBreakdown(
          breakdown as Awaited<ReturnType<ReportQueryClient['getFocusedReportBreakdown']>>,
          breakdownRequest,
        ),
        descriptor: options.descriptor,
        destination: options.destination,
        overview: requireOverview(
          cached as Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>,
          request,
        ),
      };
    }
    return {
      descriptor: options.descriptor,
      destination: options.destination,
      overview: requireOverview(cached as Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>, request),
    };
  } catch {
    return;
  }
};

export const createFocusedReportSession = (options: {
  readonly acquire: (signal: AbortSignal, force: boolean) => Promise<FocusedReportDescriptor>;
  readonly client: ReportQueryClient;
  readonly onCommit: (commit: FocusedReportCommit) => void;
  readonly queryClient: QueryClient;
  readonly sessionOwner: Pick<SessionTableQueryOwner, 'commitWithVisible' | 'prepare'>;
}): ServedReportSession<FocusedReportDestination, FocusedReportDescriptor> =>
  createServedReportSession<FocusedReportDestination, PreparedFocusedReport, FocusedReportDescriptor>({
    acquire: options.acquire,
    commit: (prepared, descriptor, destination, finalizeVisibleCommit) => {
      const publishVisible = (): void => {
        options.onCommit({
          ...(prepared.breakdown === undefined ? {} : { breakdown: prepared.breakdown }),
          descriptor,
          destination,
          overview: prepared.overview,
        });
        finalizeVisibleCommit();
      };
      if (!prepared.sessions) {
        publishVisible();
        return true;
      }
      const outcome = options.sessionOwner.commitWithVisible(prepared.sessions, publishVisible);
      if (outcome === 'superseded') {
        throw new Error('The prepared Sessions destination was superseded before commit');
      }
      return outcome === 'published';
    },
    destinationFingerprint,
    isRevisionExpired: (error) =>
      error instanceof FocusedReportRevisionExpiredError || error instanceof SessionTableRevisionExpiredError,
    load: async (destination, descriptor, signal) => {
      const overviewRequest = overviewRequestFor(destination, descriptor.revision);
      const overviewQuery = reportOverviewQueryOptions(options.client, overviewRequest, { browser: true });
      const overviewPromise = readExactQuery<Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>>(
        options.queryClient,
        overviewQuery,
        signal,
      );
      if (destination.kind === 'overview') {
        return { overview: requireOverview(await overviewPromise, overviewRequest) };
      }
      if (destination.kind === 'sessions') {
        const [overviewResult, sessions] = await Promise.all([
          overviewPromise,
          options.sessionOwner.prepare(destination.sessions, descriptor.revision, signal),
        ]);
        return { overview: requireOverview(overviewResult, overviewRequest), sessions };
      }
      const breakdownRequest: FocusedBreakdownRequest = {
        query: queryForRevision(destination.query, descriptor.revision),
      };
      const breakdownQuery = reportBreakdownQueryOptions(options.client, breakdownRequest, { browser: true });
      const [overviewResult, breakdownResult] = await Promise.all([
        overviewPromise,
        readExactQuery<Awaited<ReturnType<ReportQueryClient['getFocusedReportBreakdown']>>>(
          options.queryClient,
          breakdownQuery,
          signal,
        ),
      ]);
      return {
        breakdown: requireFocusedBreakdown(breakdownResult, breakdownRequest),
        overview: requireOverview(overviewResult, overviewRequest),
      };
    },
  });
