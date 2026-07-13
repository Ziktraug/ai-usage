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

interface RevisionRequestByKind {
  breakdown: FocusedBreakdownRequest;
  'campaign-children': SessionCampaignChildrenRequest;
  neighbors: SessionNeighborRequest;
  overview: FocusedOverviewRequest;
  sessions: SessionQueryRequest;
  support: FocusedRevisionRequest;
}

interface RevisionResultByKind {
  breakdown: FocusedBreakdownResult;
  'campaign-children': SessionCampaignChildrenResult;
  neighbors: SessionNeighborResult;
  overview: FocusedOverviewResult;
  sessions: SessionPageResult;
  support: FocusedSupportResult;
}

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { revisionQueryRunner, rootDir } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});

const parseRequest = <Kind extends RevisionQueryKind>(
  kind: Kind,
  input: RevisionRequestByKind[Kind],
): RevisionRequestByKind[Kind] => {
  if (kind === 'breakdown') {
    return parseFocusedBreakdownRequest(input) as RevisionRequestByKind[Kind];
  }
  if (kind === 'overview') {
    return parseFocusedOverviewRequest(input) as RevisionRequestByKind[Kind];
  }
  if (kind === 'support') {
    return parseFocusedRevisionRequest(input) as RevisionRequestByKind[Kind];
  }
  if (kind === 'sessions') {
    return parseSessionQueryRequest(input) as RevisionRequestByKind[Kind];
  }
  if (kind === 'campaign-children') {
    return parseSessionCampaignChildrenRequest(input) as RevisionRequestByKind[Kind];
  }
  return parseSessionNeighborRequest(input) as RevisionRequestByKind[Kind];
};

const requestRevision = <Kind extends RevisionQueryKind>(
  kind: Kind,
  request: RevisionRequestByKind[Kind],
): ReportRevision => {
  if (kind === 'sessions') {
    return parseReportRevision((request as SessionQueryRequest).revision);
  }
  if (kind === 'campaign-children') {
    return parseReportRevision((request as SessionCampaignChildrenRequest).query.revision);
  }
  if (kind === 'neighbors') {
    return parseReportRevision((request as SessionNeighborRequest).query.revision);
  }
  if (kind === 'overview' || kind === 'breakdown') {
    return parseReportRevision((request as FocusedOverviewRequest | FocusedBreakdownRequest).query.revision);
  }
  return parseReportRevision((request as FocusedRevisionRequest).revision);
};

const requestFingerprint = <Kind extends RevisionQueryKind>(
  kind: Kind,
  request: RevisionRequestByKind[Kind],
): string => {
  if (kind === 'sessions') {
    return sessionQueryFingerprint(request as SessionQueryRequest);
  }
  if (kind === 'campaign-children') {
    return sessionCampaignChildrenFingerprint(request as SessionCampaignChildrenRequest);
  }
  if (kind === 'neighbors') {
    return sessionNeighborFingerprint(request as SessionNeighborRequest);
  }
  if (kind === 'overview') {
    return focusedOverviewFingerprint(request as FocusedOverviewRequest);
  }
  if (kind === 'breakdown') {
    return focusedBreakdownFingerprint(request as FocusedBreakdownRequest);
  }
  return focusedRevisionFingerprint(kind, request as FocusedRevisionRequest);
};

const parseResult = <Kind extends RevisionQueryKind>(
  kind: Kind,
  request: RevisionRequestByKind[Kind],
  serialized: string,
): RevisionResultByKind[Kind] => {
  const value: unknown = JSON.parse(serialized);
  if (kind === 'sessions') {
    return parseSessionPageResult(value, request as SessionQueryRequest) as RevisionResultByKind[Kind];
  }
  if (kind === 'campaign-children') {
    return parseSessionCampaignChildrenResult(
      value,
      request as SessionCampaignChildrenRequest,
    ) as RevisionResultByKind[Kind];
  }
  if (kind === 'neighbors') {
    return parseSessionNeighborResult(value, request as SessionNeighborRequest) as RevisionResultByKind[Kind];
  }
  return parseFocusedReportQueryResult(
    kind,
    value,
    request as FocusedOverviewRequest | FocusedBreakdownRequest | FocusedRevisionRequest,
  ) as RevisionResultByKind[Kind];
};

export const runRevisionQueryForServer = async <Kind extends RevisionQueryKind>(
  kind: Kind,
  input: RevisionRequestByKind[Kind],
): Promise<SessionQueryServerResult<RevisionResultByKind[Kind]>> => {
  const request = parseRequest(kind, input);
  const revision = requestRevision(kind, request);
  const fingerprint = requestFingerprint(kind, request);
  try {
    const lease = await withReportRevisionDirectoryForServer(revision, async (revisionDirectory) => {
      const result = await runReportPayloadArtifactProcess({
        args: [revisionQueryRunner, revisionDirectory, kind, JSON.stringify(request)],
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
      error: { message: error instanceof Error ? error.message : String(error), revision, tag: 'QueryFailed' },
      ok: false,
      requestFingerprint: fingerprint,
      revision,
    };
  }
};
