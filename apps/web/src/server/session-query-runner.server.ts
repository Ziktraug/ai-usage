import type {
  SessionCampaignChildrenRequest,
  SessionCampaignChildrenResult,
  SessionNeighborRequest,
  SessionNeighborResult,
  SessionPageResult,
  SessionQueryRequest,
  SessionQueryServerResult,
} from '@ai-usage/report-core/session-query';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionCampaignChildrenResult,
  parseSessionNeighborRequest,
  parseSessionNeighborResult,
  parseSessionPageResult,
  parseSessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { parseReportRevision, type ReportRevision } from '../web-report-payload';
import { runReportPayloadArtifactProcess, withReportRevisionDirectoryForServer } from './report-payload.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

export type SessionQueryRunnerKind = 'campaign-children' | 'neighbors' | 'sessions';

interface SessionQueryRunnerRequestByKind {
  'campaign-children': SessionCampaignChildrenRequest;
  neighbors: SessionNeighborRequest;
  sessions: SessionQueryRequest;
}

interface SessionQueryRunnerResultByKind {
  'campaign-children': SessionCampaignChildrenResult;
  neighbors: SessionNeighborResult;
  sessions: SessionPageResult;
}

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { rootDir, sessionQueryRunner } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});

const requestRevision = (kind: SessionQueryRunnerKind, request: unknown): ReportRevision => {
  if (kind === 'sessions') {
    return parseReportRevision(parseSessionQueryRequest(request).revision);
  }
  if (kind === 'campaign-children') {
    return parseReportRevision(parseSessionCampaignChildrenRequest(request).query.revision);
  }
  return parseReportRevision(parseSessionNeighborRequest(request).query.revision);
};

const expectedFingerprint = (kind: SessionQueryRunnerKind, request: unknown): string => {
  if (kind === 'sessions') {
    return sessionQueryFingerprint(parseSessionQueryRequest(request));
  }
  if (kind === 'campaign-children') {
    return sessionCampaignChildrenFingerprint(parseSessionCampaignChildrenRequest(request));
  }
  return sessionNeighborFingerprint(parseSessionNeighborRequest(request));
};

const parseRunnerResult = <Kind extends SessionQueryRunnerKind>(
  kind: Kind,
  request: SessionQueryRunnerRequestByKind[Kind],
  serialized: string,
): SessionQueryRunnerResultByKind[Kind] => {
  const value: unknown = JSON.parse(serialized);
  if (kind === 'sessions') {
    return parseSessionPageResult(value, request as SessionQueryRequest) as SessionQueryRunnerResultByKind[Kind];
  }
  if (kind === 'campaign-children') {
    return parseSessionCampaignChildrenResult(
      value,
      request as SessionCampaignChildrenRequest,
    ) as SessionQueryRunnerResultByKind[Kind];
  }
  return parseSessionNeighborResult(value, request as SessionNeighborRequest) as SessionQueryRunnerResultByKind[Kind];
};

export const runSessionQueryForServer = async <Kind extends SessionQueryRunnerKind>(
  kind: Kind,
  input: SessionQueryRunnerRequestByKind[Kind],
): Promise<SessionQueryServerResult<SessionQueryRunnerResultByKind[Kind]>> => {
  const revision = requestRevision(kind, input);
  const requestFingerprint = expectedFingerprint(kind, input);
  try {
    const lease = await withReportRevisionDirectoryForServer(revision, async (revisionDirectory) => {
      const result = await runReportPayloadArtifactProcess({
        args: [sessionQueryRunner, revisionDirectory, kind, JSON.stringify(input)],
        command: 'bun',
        cwd: rootDir,
      });
      return parseRunnerResult(kind, input, result.serializedPayload);
    });
    if (!lease.ok) {
      return {
        error: { message: lease.error.message, revision, tag: 'RevisionExpired' },
        ok: false,
        requestFingerprint,
        revision,
      };
    }
    return { data: lease.value, ok: true, requestFingerprint, revision };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        revision,
        tag: 'QueryFailed',
      },
      ok: false,
      requestFingerprint,
      revision,
    };
  }
};
