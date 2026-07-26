import {
  annotateWideEvent,
  type BoundaryClassification,
  classifyExit,
  runBoundaryEffect,
  WideEventService,
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
import { runBoundedArtifactProcess } from './bounded-artifact-process.server';
import { withReportRevisionQueryLeaseForServer } from './report-payload.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';
import { getWebProcessRuntime } from './web-process-runtime.server';

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
  fingerprint: string;
  parseResult(serialized: string): Result;
  revision: ReportRevision;
  serializedRequest: string;
  sessionSummary?: {
    readonly hasCursor: boolean;
    readonly pageSize: number;
  };
}

interface RevisionQuerySpec<Result extends RevisionQueryResult> {
  parse(input: unknown): ParsedRevisionRequest<Result>;
}

interface RevisionQueryExecutionRequest {
  kind: RevisionQueryKind;
  revision: ReportRevision;
  serializedRequest: string;
}

interface RevisionQueryExecutionDiagnostics {
  readonly boundedRunnerMs?: number;
  readonly leaseWaitMs?: number;
}

type RevisionQueryExecutionResult =
  | { diagnostics?: RevisionQueryExecutionDiagnostics; ok: true; serializedPayload: string }
  | { diagnostics?: RevisionQueryExecutionDiagnostics; message: string; ok: false };

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

export interface RevisionQueryRunnerDependencies {
  execute(request: RevisionQueryExecutionRequest): Promise<RevisionQueryExecutionResult>;
}

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { revisionQueryRunner, rootDir } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});

const jsonValue = (serialized: string): unknown => JSON.parse(serialized);

const boundedPhaseDuration = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.min(value, sourceControlBounds.maxDurationMs) : 0;

const defaultDependencies: RevisionQueryRunnerDependencies = {
  execute: async ({ kind, revision, serializedRequest }) => {
    const leaseRequestedAt = performance.now();
    const lease = await withReportRevisionQueryLeaseForServer(revision, async (revisionDirectory) => {
      const leaseWaitMs = boundedPhaseDuration(performance.now() - leaseRequestedAt);
      const boundedRunnerStartedAt = performance.now();
      const result = await runBoundedArtifactProcess({
        args: [revisionQueryRunner, revisionDirectory, kind, serializedRequest],
        command: 'bun',
        cwd: rootDir,
      });
      return {
        boundedRunnerMs: boundedPhaseDuration(performance.now() - boundedRunnerStartedAt),
        leaseWaitMs,
        serializedPayload: result.serializedPayload,
      };
    });
    if (!lease.ok) {
      return { message: lease.error.message, ok: false };
    }
    return {
      diagnostics: {
        boundedRunnerMs: lease.value.boundedRunnerMs,
        leaseWaitMs: lease.value.leaseWaitMs,
      },
      ok: true,
      serializedPayload: lease.value.serializedPayload,
    };
  },
};

const executionAnnotations = (diagnostics: RevisionQueryExecutionDiagnostics | undefined): Record<string, number> => ({
  ...(diagnostics?.boundedRunnerMs === undefined ? {} : { boundedRunnerMs: diagnostics.boundedRunnerMs }),
  ...(diagnostics?.leaseWaitMs === undefined ? {} : { leaseWaitMs: diagnostics.leaseWaitMs }),
});

type SessionQueryFailure = Extract<SessionQueryServerResult<never>, { ok: false }>;

const queryFailedResult = (
  request: { readonly fingerprint: string; readonly revision: ReportRevision },
  error: unknown,
): SessionQueryFailure => ({
  error: {
    message: error instanceof Error ? error.message : String(error),
    revision: request.revision,
    tag: 'QueryFailed',
  },
  ok: false,
  requestFingerprint: request.fingerprint,
  revision: request.revision,
});

const revisionExpiredResult = (
  request: { readonly fingerprint: string; readonly revision: ReportRevision },
  message: string,
): SessionQueryFailure => ({
  error: {
    message,
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
      try: () =>
        dependencies.execute({
          kind,
          revision: request.revision,
          serializedRequest: request.serializedRequest,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.tap(({ diagnostics }) => annotateWideEventIfAvailable(executionAnnotations(diagnostics))),
      withMeasuredIfAvailable('revision.execute'),
    );

    if (!execution.ok) {
      return revisionExpiredResult(request, execution.message);
    }

    const data = yield* Effect.try({
      try: () => request.parseResult(execution.serializedPayload),
      catch: (error) => error,
    }).pipe(withMeasuredIfAvailable('revision.parse'));

    return successfulQueryResult(request, data);
  }).pipe(Effect.catchAll((error) => Effect.succeed(queryFailedResult(request, error))));

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
        parseResult: (serialized) => parseFocusedReportQueryResult('breakdown', jsonValue(serialized), request),
        revision: parseReportRevision(request.query.revision),
        serializedRequest: JSON.stringify(request),
      };
    },
  },
  'campaign-children': {
    parse: (input) => {
      const request = parseSessionCampaignChildrenRequest(input);
      return {
        fingerprint: sessionCampaignChildrenFingerprint(request),
        parseResult: (serialized) => parseSessionCampaignChildrenResult(jsonValue(serialized), request),
        revision: parseReportRevision(request.query.revision),
        serializedRequest: JSON.stringify(request),
      };
    },
  },
  neighbors: {
    parse: (input) => {
      const request = parseSessionNeighborRequest(input);
      return {
        fingerprint: sessionNeighborFingerprint(request),
        parseResult: (serialized) => parseSessionNeighborResult(jsonValue(serialized), request),
        revision: parseReportRevision(request.query.revision),
        serializedRequest: JSON.stringify(request),
      };
    },
  },
  'session-detail-anchor': {
    parse: (input) => {
      const request = parseSessionDetailRequest(input);
      return {
        fingerprint: sessionDetailRequestFingerprint(request),
        parseResult: (serialized) => parseSessionDetailAnchorResult(jsonValue(serialized), request),
        revision: parseReportRevision(request.revision),
        serializedRequest: JSON.stringify(request),
      };
    },
  },
  overview: {
    parse: (input) => {
      const request = parseFocusedOverviewRequest(input);
      return {
        fingerprint: focusedOverviewFingerprint(request),
        parseResult: (serialized) => parseFocusedReportQueryResult('overview', jsonValue(serialized), request),
        revision: parseReportRevision(request.query.revision),
        serializedRequest: JSON.stringify(request),
      };
    },
  },
  sessions: {
    parse: (input) => {
      const request = parseSessionQueryRequest(input);
      return {
        fingerprint: sessionQueryFingerprint(request),
        parseResult: (serialized) => parseSessionPageResult(jsonValue(serialized), request),
        revision: parseReportRevision(request.revision),
        serializedRequest: JSON.stringify(request),
        sessionSummary: { hasCursor: request.cursor !== null, pageSize: request.pageSize },
      };
    },
  },
  support: {
    parse: (input) => {
      const request = parseFocusedRevisionRequest(input);
      return {
        fingerprint: focusedRevisionFingerprint('support', request),
        parseResult: (serialized) => parseFocusedReportQueryResult('support', jsonValue(serialized), request),
        revision: parseReportRevision(request.revision),
        serializedRequest: JSON.stringify(request),
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
): Promise<SessionQueryServerResult<FocusedBreakdownResult>>;
export function runRevisionQueryForServer(
  kind: 'campaign-children',
  input: SessionCampaignChildrenRequest,
): Promise<SessionQueryServerResult<SessionCampaignChildrenResult>>;
export function runRevisionQueryForServer(
  kind: 'neighbors',
  input: SessionNeighborRequest,
): Promise<SessionQueryServerResult<SessionNeighborResult>>;
export function runRevisionQueryForServer(
  kind: 'session-detail-anchor',
  input: SessionDetailRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionDetailAnchorResult>>;
export function runRevisionQueryForServer(
  kind: 'overview',
  input: FocusedOverviewRequest,
): Promise<SessionQueryServerResult<FocusedOverviewResult>>;
export function runRevisionQueryForServer(
  kind: 'sessions',
  input: SessionQueryRequest,
  dependencies?: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionPageResult>>;
export function runRevisionQueryForServer(
  kind: 'support',
  input: FocusedRevisionRequest,
): Promise<SessionQueryServerResult<FocusedSupportResult>>;
export async function runRevisionQueryForServer(
  kind: RevisionQueryKind,
  input: unknown,
  dependencies: RevisionQueryRunnerDependencies = defaultDependencies,
): Promise<SessionQueryServerResult<RevisionQueryResult>> {
  if (kind === 'sessions') {
    const request = parseRevisionRequest(kind, input);
    const query = runParsedRevisionQuery(kind, request, dependencies);
    try {
      return await getWebProcessRuntime().effects.runEffect(withSessionQueryBoundary(request, query));
    } catch (error) {
      return queryFailedResult(request, error);
    }
  }

  const request = parseRevisionRequest(kind, input);
  return await Effect.runPromise(runParsedRevisionQuery(kind, request, dependencies));
}
