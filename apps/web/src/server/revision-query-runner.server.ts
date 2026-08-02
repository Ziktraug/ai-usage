import {
  annotateWideEvent,
  type BoundaryClassification,
  classifyExit,
  runBoundaryEffect,
  type WideEventResourceService,
  WideEventService,
  type WideEventSink,
  withMeasuredIfAvailable,
} from '@ai-usage/effect-runtime';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportQueryKind,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedReportQueryResult,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import {
  parseSessionDetailAnchorResult,
  parseSessionDetailRequest,
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
  sessionDetailRequestFingerprint,
} from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionCampaignChildrenResult,
  parseSessionNeighborRequest,
  parseSessionNeighborResult,
  parseSessionPageResult,
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionCampaignChildrenResult,
  type SessionNeighborRequest,
  type SessionNeighborResult,
  type SessionPageResult,
  type SessionQueryRequest,
  type SessionQueryServerResult,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { sourceControlBounds } from '@ai-usage/report-core/source-control';
import { Effect, Exit, Option } from 'effect';
import { parseReportRevision, type ReportRevision } from '../web-report-payload';
import type { UsageReadModel } from './usage-read-model.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';
import { runWebReadEffect } from './web-read-observability.server';

export type RevisionQueryKind =
  | FocusedReportQueryKind
  | 'campaign-children'
  | 'neighbors'
  | 'session-detail-anchor'
  | 'sessions';

interface RevisionQueryResultByKind {
  breakdown: FocusedBreakdownResult;
  'campaign-children': SessionCampaignChildrenResult;
  neighbors: SessionNeighborResult;
  overview: FocusedOverviewResult;
  'session-detail-anchor': SessionDetailAnchorResult;
  sessions: SessionPageResult;
  support: FocusedSupportResult;
}

type RevisionQueryResult = RevisionQueryResultByKind[RevisionQueryKind];

interface ParsedRevisionRequest<Result extends RevisionQueryResult> {
  readonly fingerprint: string;
  readonly request: unknown;
  readonly revision: ReportRevision;
  readonly sessionSummary?: {
    readonly hasCursor: boolean;
    readonly pageSize: number;
  };
  readonly validateResult: (value: unknown) => Result;
}

interface RevisionQuerySpec<Result extends RevisionQueryResult> {
  readonly parse: (input: unknown) => ParsedRevisionRequest<Result>;
}

export interface RevisionQueryExecutionRequest {
  readonly kind: RevisionQueryKind;
  readonly request: unknown;
  readonly revision: ReportRevision;
}

interface RevisionQueryExecutionDiagnostics {
  readonly sqliteReadMs?: number;
}

export type RevisionQueryExecutionResult =
  | {
      readonly diagnostics?: RevisionQueryExecutionDiagnostics;
      readonly failure: 'query-failed' | 'revision-expired';
      readonly ok: false;
    }
  | {
      readonly diagnostics?: RevisionQueryExecutionDiagnostics;
      readonly ok: true;
      readonly value: unknown;
    };

export interface RevisionQueryRunnerDependencies {
  readonly execute: (request: RevisionQueryExecutionRequest) => Promise<RevisionQueryExecutionResult>;
  readonly runEffect?: <Value, Failure>(
    effect: Effect.Effect<Value, Failure, WideEventResourceService | WideEventSink>,
  ) => Promise<Value>;
}

const classifySessionQueryResult = (
  exit: Exit.Exit<SessionQueryServerResult<SessionPageResult>, unknown>,
): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return { ...classifyExit(exit), annotations: { failureKind: 'query-failed' } };
  }
  if (exit.value.ok) {
    return { outcome: 'success' };
  }
  return {
    outcome: 'failure',
    annotations: {
      failureKind: exit.value.error.tag === 'RevisionExpired' ? 'revision-expired' : 'query-failed',
    },
  };
};

const boundedPhaseDuration = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.min(value, sourceControlBounds.maxDurationMs) : 0;

const isRevisionExpiry = (error: unknown): boolean => {
  if (!(typeof error === 'object' && error !== null && 'reason' in error)) {
    return false;
  }
  return error.reason === 'revision-expired' || error.reason === 'revision-unavailable';
};

export const resolveRevisionQueryRunnerDependenciesForServer = async (
  resolveReadModel: () => Promise<Pick<UsageReadModel, 'queryRevision'>> = resolveUsageReadModelForServer,
): Promise<RevisionQueryRunnerDependencies> => {
  const readModel = await resolveReadModel();
  return {
    execute: async ({ kind, request, revision }) => {
      const startedAt = performance.now();
      try {
        const value = await readModel.queryRevision({ kind, request, revision });
        return {
          diagnostics: { sqliteReadMs: boundedPhaseDuration(performance.now() - startedAt) },
          ok: true,
          value,
        };
      } catch (error) {
        return {
          diagnostics: { sqliteReadMs: boundedPhaseDuration(performance.now() - startedAt) },
          failure: isRevisionExpiry(error) ? 'revision-expired' : 'query-failed',
          ok: false,
        };
      }
    },
    runEffect: runWebReadEffect,
  };
};

const executionAnnotations = (diagnostics: RevisionQueryExecutionDiagnostics | undefined): Record<string, number> =>
  diagnostics?.sqliteReadMs === undefined ? {} : { sqliteReadMs: diagnostics.sqliteReadMs };

type SessionQueryFailure = Extract<SessionQueryServerResult<never>, { ok: false }>;

const queryFailedResult = (request: {
  readonly fingerprint: string;
  readonly revision: ReportRevision;
}): SessionQueryFailure => ({
  error: {
    message: 'The report query could not be completed.',
    revision: request.revision,
    tag: 'QueryFailed',
  },
  ok: false,
  requestFingerprint: request.fingerprint,
  revision: request.revision,
});

const revisionExpiredResult = (request: {
  readonly fingerprint: string;
  readonly revision: ReportRevision;
}): SessionQueryFailure => ({
  error: {
    message: 'The requested report revision is unavailable.',
    revision: request.revision,
    tag: 'RevisionExpired',
  },
  ok: false,
  requestFingerprint: request.fingerprint,
  revision: request.revision,
});

const successfulQueryResult = <Result extends RevisionQueryResult>(
  request: { readonly fingerprint: string; readonly revision: ReportRevision },
  data: Result,
): SessionQueryServerResult<Result> => ({
  data,
  ok: true,
  requestFingerprint: request.fingerprint,
  revision: request.revision,
});

const annotateWideEventIfAvailable = (annotations: Readonly<Record<string, number>>): Effect.Effect<void> =>
  Effect.serviceOption(WideEventService).pipe(
    Effect.flatMap((wideEvent) => (Option.isNone(wideEvent) ? Effect.void : wideEvent.value.annotate(annotations))),
  );

const runParsedRevisionQuery = <Result extends RevisionQueryResult>(
  kind: RevisionQueryKind,
  request: ParsedRevisionRequest<Result>,
  dependencies: RevisionQueryRunnerDependencies,
): Effect.Effect<SessionQueryServerResult<Result>, never> =>
  Effect.gen(function* () {
    const execution = yield* Effect.tryPromise({
      try: () => dependencies.execute({ kind, request: request.request, revision: request.revision }),
      catch: (error) => error,
    }).pipe(
      Effect.tap(({ diagnostics }) => annotateWideEventIfAvailable(executionAnnotations(diagnostics))),
      withMeasuredIfAvailable('revision.execute'),
    );

    if (!execution.ok) {
      return execution.failure === 'revision-expired' ? revisionExpiredResult(request) : queryFailedResult(request);
    }

    const data = yield* Effect.try({
      try: () => request.validateResult(execution.value),
      catch: (error) => error,
    }).pipe(withMeasuredIfAvailable('revision.parse'));
    return successfulQueryResult(request, data);
  }).pipe(Effect.catchAll(() => Effect.succeed(queryFailedResult(request))));

const withSessionQueryBoundary = (
  request: ParsedRevisionRequest<SessionPageResult>,
  query: Effect.Effect<SessionQueryServerResult<SessionPageResult>, never>,
) =>
  runBoundaryEffect(
    {
      boundary: 'web.sessions.read',
      annotations: { fingerprint: request.fingerprint, revision: request.revision },
      classify: classifySessionQueryResult,
    },
    query.pipe(
      Effect.tap((result) => {
        if (!result.ok) {
          return Effect.void;
        }
        return annotateWideEvent({
          hasCursor: request.sessionSummary?.hasCursor ?? false,
          hasMore: result.data.nextCursor !== null,
          itemCount: result.data.itemCount,
          pageSize: request.sessionSummary?.pageSize ?? result.data.items.length,
          queryKind: 'sessions',
          sessionCount: result.data.sessionCount,
        });
      }),
    ),
  );

const revisionQuerySpecs: {
  readonly [Kind in RevisionQueryKind]: RevisionQuerySpec<RevisionQueryResultByKind[Kind]>;
} = {
  breakdown: {
    parse: (input) => {
      const request = parseFocusedBreakdownRequest(input);
      return {
        fingerprint: focusedBreakdownFingerprint(request),
        request,
        revision: parseReportRevision(request.query.revision),
        validateResult: (value) => parseFocusedReportQueryResult('breakdown', value, request),
      };
    },
  },
  'campaign-children': {
    parse: (input) => {
      const request = parseSessionCampaignChildrenRequest(input);
      return {
        fingerprint: sessionCampaignChildrenFingerprint(request),
        request,
        revision: parseReportRevision(request.query.revision),
        validateResult: (value) => parseSessionCampaignChildrenResult(value, request),
      };
    },
  },
  neighbors: {
    parse: (input) => {
      const request = parseSessionNeighborRequest(input);
      return {
        fingerprint: sessionNeighborFingerprint(request),
        request,
        revision: parseReportRevision(request.query.revision),
        validateResult: (value) => parseSessionNeighborResult(value, request),
      };
    },
  },
  'session-detail-anchor': {
    parse: (input) => {
      const request = parseSessionDetailRequest(input);
      return {
        fingerprint: sessionDetailRequestFingerprint(request),
        request,
        revision: parseReportRevision(request.revision),
        validateResult: (value) => parseSessionDetailAnchorResult(value, request),
      };
    },
  },
  overview: {
    parse: (input) => {
      const request = parseFocusedOverviewRequest(input);
      return {
        fingerprint: focusedOverviewFingerprint(request),
        request,
        revision: parseReportRevision(request.query.revision),
        validateResult: (value) => parseFocusedReportQueryResult('overview', value, request),
      };
    },
  },
  sessions: {
    parse: (input) => {
      const request = parseSessionQueryRequest(input);
      return {
        fingerprint: sessionQueryFingerprint(request),
        request,
        revision: parseReportRevision(request.revision),
        sessionSummary: { hasCursor: request.cursor !== null, pageSize: request.pageSize },
        validateResult: (value) => parseSessionPageResult(value, request),
      };
    },
  },
  support: {
    parse: (input) => {
      const request = parseFocusedRevisionRequest(input);
      return {
        fingerprint: focusedRevisionFingerprint('support', request),
        request,
        revision: parseReportRevision(request.revision),
        validateResult: (value) => parseFocusedReportQueryResult('support', value, request),
      };
    },
  },
};

const parseRevisionRequest = <Kind extends RevisionQueryKind>(
  kind: Kind,
  input: unknown,
): ParsedRevisionRequest<RevisionQueryResultByKind[Kind]> => revisionQuerySpecs[kind].parse(input);

export function runRevisionQueryForServer(
  kind: 'breakdown',
  input: FocusedBreakdownRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<FocusedBreakdownResult>>;
export function runRevisionQueryForServer(
  kind: 'campaign-children',
  input: SessionCampaignChildrenRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionCampaignChildrenResult>>;
export function runRevisionQueryForServer(
  kind: 'neighbors',
  input: SessionNeighborRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionNeighborResult>>;
export function runRevisionQueryForServer(
  kind: 'session-detail-anchor',
  input: SessionDetailRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionDetailAnchorResult>>;
export function runRevisionQueryForServer(
  kind: 'overview',
  input: FocusedOverviewRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<FocusedOverviewResult>>;
export function runRevisionQueryForServer(
  kind: 'sessions',
  input: SessionQueryRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionPageResult>>;
export function runRevisionQueryForServer(
  kind: 'support',
  input: FocusedRevisionRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<FocusedSupportResult>>;
export async function runRevisionQueryForServer(
  kind: RevisionQueryKind,
  input: unknown,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<RevisionQueryResult>> {
  const activeDependencies = dependencies ?? (await resolveRevisionQueryRunnerDependenciesForServer());
  if (kind === 'sessions') {
    const request = parseRevisionRequest('sessions', input);
    const query = runParsedRevisionQuery('sessions', request, activeDependencies);
    try {
      return await (activeDependencies.runEffect ?? runWebReadEffect)(withSessionQueryBoundary(request, query));
    } catch {
      return queryFailedResult(request);
    }
  }
  const request = parseRevisionRequest(kind, input);
  return await Effect.runPromise(runParsedRevisionQuery(kind, request, activeDependencies));
}
