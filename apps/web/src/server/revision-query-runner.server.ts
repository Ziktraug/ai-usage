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
import { parseReportRevision, type ReportRevision } from '../web-report-payload';
import { runReportPayloadArtifactProcess, withReportRevisionDirectoryForServer } from './report-payload.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

export type RevisionQueryKind = FocusedReportQueryKind | 'campaign-children' | 'neighbors' | 'sessions';
type RevisionQueryResult =
  | FocusedBreakdownResult
  | FocusedOverviewResult
  | FocusedSupportResult
  | SessionCampaignChildrenResult
  | SessionNeighborResult
  | SessionPageResult;

interface ParsedRevisionRequest<Result extends RevisionQueryResult> {
  fingerprint: string;
  parseResult(serialized: string): Result;
  revision: ReportRevision;
  serializedRequest: string;
}

interface RevisionQuerySpec<Result extends RevisionQueryResult> {
  parse(input: unknown): ParsedRevisionRequest<Result>;
}

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { revisionQueryRunner, rootDir } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});

const jsonValue = (serialized: string): unknown => JSON.parse(serialized);

const revisionQuerySpecs: {
  breakdown: RevisionQuerySpec<FocusedBreakdownResult>;
  'campaign-children': RevisionQuerySpec<SessionCampaignChildrenResult>;
  neighbors: RevisionQuerySpec<SessionNeighborResult>;
  overview: RevisionQuerySpec<FocusedOverviewResult>;
  sessions: RevisionQuerySpec<SessionPageResult>;
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
  kind: 'overview',
  input: FocusedOverviewRequest,
): Promise<SessionQueryServerResult<FocusedOverviewResult>>;
export function runRevisionQueryForServer(
  kind: 'sessions',
  input: SessionQueryRequest,
): Promise<SessionQueryServerResult<SessionPageResult>>;
export function runRevisionQueryForServer(
  kind: 'support',
  input: FocusedRevisionRequest,
): Promise<SessionQueryServerResult<FocusedSupportResult>>;
export async function runRevisionQueryForServer(
  kind: RevisionQueryKind,
  input: unknown,
): Promise<SessionQueryServerResult<RevisionQueryResult>> {
  const request = revisionQuerySpecs[kind].parse(input);
  try {
    const lease = await withReportRevisionDirectoryForServer(request.revision, async (revisionDirectory) => {
      const result = await runReportPayloadArtifactProcess({
        args: [revisionQueryRunner, revisionDirectory, kind, request.serializedRequest],
        command: 'bun',
        cwd: rootDir,
      });
      return request.parseResult(result.serializedPayload);
    });
    if (!lease.ok) {
      return {
        error: { message: lease.error.message, revision: request.revision, tag: 'RevisionExpired' },
        ok: false,
        requestFingerprint: request.fingerprint,
        revision: request.revision,
      };
    }
    return {
      data: lease.value,
      ok: true,
      requestFingerprint: request.fingerprint,
      revision: request.revision,
    };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        revision: request.revision,
        tag: 'QueryFailed',
      },
      ok: false,
      requestFingerprint: request.fingerprint,
      revision: request.revision,
    };
  }
}
