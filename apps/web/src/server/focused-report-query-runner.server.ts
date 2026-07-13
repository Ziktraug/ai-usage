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
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { parseReportRevision, type ReportRevision } from '../web-report-payload';
import { runReportPayloadArtifactProcess, withReportRevisionDirectoryForServer } from './report-payload.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

interface FocusedRequestByKind {
  breakdown: FocusedBreakdownRequest;
  overview: FocusedOverviewRequest;
  support: FocusedRevisionRequest;
}

interface FocusedResultByKind {
  breakdown: FocusedBreakdownResult;
  overview: FocusedOverviewResult;
  support: FocusedSupportResult;
}

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { focusedReportQueryRunner, rootDir } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});

const parseRequest = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  input: FocusedRequestByKind[Kind],
): FocusedRequestByKind[Kind] => {
  if (kind === 'overview') {
    return parseFocusedOverviewRequest(input) as FocusedRequestByKind[Kind];
  }
  if (kind === 'breakdown') {
    return parseFocusedBreakdownRequest(input) as FocusedRequestByKind[Kind];
  }
  return parseFocusedRevisionRequest(input) as FocusedRequestByKind[Kind];
};

const requestRevision = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  input: FocusedRequestByKind[Kind],
): ReportRevision => {
  const request = parseRequest(kind, input);
  return parseReportRevision(
    kind === 'overview' || kind === 'breakdown'
      ? (request as FocusedOverviewRequest | FocusedBreakdownRequest).query.revision
      : (request as FocusedRevisionRequest).revision,
  );
};

const requestFingerprint = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  input: FocusedRequestByKind[Kind],
): string => {
  const request = parseRequest(kind, input);
  if (kind === 'overview') {
    return focusedOverviewFingerprint(request as FocusedOverviewRequest);
  }
  if (kind === 'breakdown') {
    return focusedBreakdownFingerprint(request as FocusedBreakdownRequest);
  }
  return focusedRevisionFingerprint(kind, request as FocusedRevisionRequest);
};

const parseResult = <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  request: FocusedRequestByKind[Kind],
  serialized: string,
): FocusedResultByKind[Kind] =>
  parseFocusedReportQueryResult(kind, JSON.parse(serialized) as unknown, request) as FocusedResultByKind[Kind];

export const runFocusedReportQueryForServer = async <Kind extends FocusedReportQueryKind>(
  kind: Kind,
  input: FocusedRequestByKind[Kind],
): Promise<SessionQueryServerResult<FocusedResultByKind[Kind]>> => {
  const request = parseRequest(kind, input);
  const revision = requestRevision(kind, request);
  const fingerprint = requestFingerprint(kind, request);
  try {
    const lease = await withReportRevisionDirectoryForServer(revision, async (revisionDirectory) => {
      const result = await runReportPayloadArtifactProcess({
        args: [focusedReportQueryRunner, revisionDirectory, kind, JSON.stringify(request)],
        command: 'bun',
        cwd: rootDir,
      });
      return parseResult(kind, request, result.serializedPayload);
    });
    if (!lease.ok) {
      return {
        error: { message: lease.error.message, revision, tag: 'RevisionExpired' },
        ok: false,
        requestFingerprint: fingerprint,
        revision,
      };
    }
    return { data: lease.value, ok: true, requestFingerprint: fingerprint, revision };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        revision,
        tag: 'QueryFailed',
      },
      ok: false,
      requestFingerprint: fingerprint,
      revision,
    };
  }
};
