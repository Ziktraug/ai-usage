import {
  annotateWideEvent,
  type BoundaryClassification,
  classifyExit,
  runBoundaryEffect,
  withMeasured,
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
import { Effect, Exit } from 'effect';
import { parseReportRevision, type ReportRevision } from '../web-report-payload';
import { runBoundedArtifactProcess } from './bounded-artifact-process.server';
import { withReportRevisionQueryLeaseForServer } from './report-payload.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';
import { getWebSourceControlRuntime } from './source-control.server';

export type RevisionQueryKind =
  | FocusedReportQueryKind
  | 'campaign-children'
  | 'neighbors'
  | 'session-detail-anchor'
  | 'sessions';
type RevisionQueryResult =
  | FocusedBreakdownResult
  | FocusedOverviewResult
  | FocusedSupportResult
  | SessionCampaignChildrenResult
  | SessionNeighborResult
  | SessionDetailAnchorResult
  | SessionPageResult;

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

const runSessionQueryBoundary = (
  request: ParsedRevisionRequest<SessionPageResult>,
  executeRequest: RevisionQueryExecutionRequest,
  dependencies: RevisionQueryRunnerDependencies,
): Promise<SessionQueryServerResult<SessionPageResult>> =>
  getWebSourceControlRuntime().runEffect(
    runBoundaryEffect(
      {
        boundary: 'web.sessions.read',
        annotations: { fingerprint: request.fingerprint, revision: request.revision },
        classify: classifySessionQueryResult,
      },
      Effect.gen(function* () {
        const execution = yield* Effect.tryPromise({
          try: () => dependencies.execute(executeRequest),
          catch: (error) => error,
        }).pipe(
          Effect.tap(({ diagnostics }) => annotateWideEvent(executionAnnotations(diagnostics))),
          withMeasured('revision.execute'),
        );

        if (!execution.ok) {
          return {
            error: { message: execution.message, revision: request.revision, tag: 'RevisionExpired' },
            ok: false,
            requestFingerprint: request.fingerprint,
            revision: request.revision,
          } as const;
        }

        const parsed = yield* Effect.try({
          try: () => request.parseResult(execution.serializedPayload),
          catch: (error) => error,
        }).pipe(
          withMeasured('revision.parse'),
          Effect.match({
            onFailure: (error) => queryFailedResult(request, error),
            onSuccess: (data) => ({
              data,
              ok: true as const,
              requestFingerprint: request.fingerprint,
              revision: request.revision,
            }),
          }),
        );

        if (parsed.ok) {
          yield* annotateWideEvent({
            hasCursor: request.sessionSummary?.hasCursor ?? false,
            hasMore: parsed.data.nextCursor !== null,
            itemCount: parsed.data.itemCount,
            pageSize: request.sessionSummary?.pageSize ?? parsed.data.items.length,
            queryKind: 'sessions',
            sessionCount: parsed.data.sessionCount,
          });
        }
        return parsed;
      }),
    ),
  );

const revisionQuerySpecs: {
  breakdown: RevisionQuerySpec<FocusedBreakdownResult>;
  'campaign-children': RevisionQuerySpec<SessionCampaignChildrenResult>;
  neighbors: RevisionQuerySpec<SessionNeighborResult>;
  overview: RevisionQuerySpec<FocusedOverviewResult>;
  sessions: RevisionQuerySpec<SessionPageResult>;
  'session-detail-anchor': RevisionQuerySpec<SessionDetailAnchorResult>;
  support: RevisionQuerySpec<FocusedSupportResult>;
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
    const request = revisionQuerySpecs.sessions.parse(input);
    const executeRequest = { kind, revision: request.revision, serializedRequest: request.serializedRequest };
    try {
      return await runSessionQueryBoundary(request, executeRequest, dependencies);
    } catch (error) {
      return queryFailedResult(request, error);
    }
  }

  const request = revisionQuerySpecs[kind].parse(input);
  const executeRequest = { kind, revision: request.revision, serializedRequest: request.serializedRequest };
  try {
    const execution = await dependencies.execute(executeRequest);
    if (!execution.ok) {
      return {
        error: { message: execution.message, revision: request.revision, tag: 'RevisionExpired' },
        ok: false,
        requestFingerprint: request.fingerprint,
        revision: request.revision,
      };
    }
    return {
      data: request.parseResult(execution.serializedPayload),
      ok: true,
      requestFingerprint: request.fingerprint,
      revision: request.revision,
    };
  } catch (error) {
    return queryFailedResult(request, error);
  }
}
