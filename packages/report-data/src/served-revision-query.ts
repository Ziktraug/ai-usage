import {
  type FocusedBreakdownRequest,
  type FocusedOverviewRequest,
  type FocusedReportQueryKind,
  type FocusedReportQueryResult,
  type FocusedRevisionRequest,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
} from '@ai-usage/report-core/focused-report-query';
import {
  MAX_BREAKDOWN_REFRESH_BYTES,
  MAX_OVERVIEW_REFRESH_BYTES,
  MAX_SERVED_BOOTSTRAP_BYTES,
  MAX_SESSION_QUERY_RESULT_BYTES,
} from '@ai-usage/report-core/report-budgets';
import {
  parseSessionDetailRequest,
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
} from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionCampaignChildrenResult,
  type SessionNeighborRequest,
  type SessionNeighborResult,
  type SessionPageResult,
  type SessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import {
  assertSessionQueryCursorScope,
  queryServedRevisionData as queryStoredServedRevisionData,
  type ServedRevisionQueryTrace,
  type SessionQueryKind,
  type UsageStoreError,
} from '@ai-usage/usage-store/reader';
import { Data, Effect } from 'effect';

export type ServedRevisionQueryKind = FocusedReportQueryKind | SessionQueryKind;
export type ServedRevisionQueryResult =
  | FocusedReportQueryResult
  | SessionCampaignChildrenResult
  | SessionDetailAnchorResult
  | SessionNeighborResult
  | SessionPageResult;

export type ServedRevisionQueryErrorReason = 'invalid-request' | 'result-too-large' | 'revision-mismatch';

export class ServedRevisionQueryError extends Data.TaggedError('ServedRevisionQueryError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: ServedRevisionQueryErrorReason;
}> {}

export interface QueryServedRevisionDataInput {
  readonly dbPath: string;
  readonly kind: ServedRevisionQueryKind;
  readonly now?: number;
  readonly request: unknown;
  readonly revision: string;
  readonly trace?: (query: ServedRevisionQueryTrace) => void;
}

type ParsedRequest =
  | { readonly kind: 'breakdown'; readonly request: FocusedBreakdownRequest; readonly revision: string }
  | { readonly kind: 'campaign-children'; readonly request: SessionCampaignChildrenRequest; readonly revision: string }
  | { readonly kind: 'neighbors'; readonly request: SessionNeighborRequest; readonly revision: string }
  | { readonly kind: 'overview'; readonly request: FocusedOverviewRequest; readonly revision: string }
  | { readonly kind: 'session-detail-anchor'; readonly request: SessionDetailRequest; readonly revision: string }
  | { readonly kind: 'sessions'; readonly request: SessionQueryRequest; readonly revision: string }
  | { readonly kind: 'support'; readonly request: FocusedRevisionRequest; readonly revision: string };

const parseRequest = (kind: ServedRevisionQueryKind, value: unknown): ParsedRequest => {
  if (kind === 'sessions') {
    const request = parseSessionQueryRequest(value);
    assertSessionQueryCursorScope(request.cursor, request.revision, sessionQueryFingerprint(request));
    return { kind, request, revision: request.revision };
  }
  if (kind === 'campaign-children') {
    const request = parseSessionCampaignChildrenRequest(value);
    assertSessionQueryCursorScope(
      request.query.cursor,
      request.query.revision,
      sessionCampaignChildrenFingerprint(request),
    );
    return { kind, request, revision: request.query.revision };
  }
  if (kind === 'neighbors') {
    const request = parseSessionNeighborRequest(value);
    return { kind, request, revision: request.query.revision };
  }
  if (kind === 'session-detail-anchor') {
    const request = parseSessionDetailRequest(value);
    return { kind, request, revision: request.revision };
  }
  if (kind === 'overview') {
    const request = parseFocusedOverviewRequest(value);
    return { kind, request, revision: request.query.revision };
  }
  if (kind === 'breakdown') {
    const request = parseFocusedBreakdownRequest(value);
    return { kind, request, revision: request.query.revision };
  }
  if (kind !== 'support') {
    throw new Error(`Unknown served revision query kind: ${String(kind)}`);
  }
  const request = parseFocusedRevisionRequest(value);
  return { kind, request, revision: request.revision };
};

const maximumResultBytes = (kind: ServedRevisionQueryKind): number => {
  if (kind === 'breakdown') {
    return MAX_BREAKDOWN_REFRESH_BYTES;
  }
  if (kind === 'overview') {
    return MAX_OVERVIEW_REFRESH_BYTES;
  }
  if (kind === 'support') {
    return MAX_SERVED_BOOTSTRAP_BYTES;
  }
  return MAX_SESSION_QUERY_RESULT_BYTES;
};

const invalidRequest = (cause: unknown): ServedRevisionQueryError =>
  new ServedRevisionQueryError({
    cause,
    message: `Served revision query request is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    reason: 'invalid-request',
  });

export const queryServedRevisionData = (
  input: QueryServedRevisionDataInput,
): Effect.Effect<ServedRevisionQueryResult, ServedRevisionQueryError | UsageStoreError> => {
  let parsed: ParsedRequest;
  try {
    parsed = parseRequest(input.kind, input.request);
  } catch (cause) {
    return Effect.fail(invalidRequest(cause));
  }
  if (parsed.revision !== input.revision) {
    return Effect.fail(
      new ServedRevisionQueryError({
        message: `Served revision query request ${parsed.revision} does not match scope ${input.revision}`,
        reason: 'revision-mismatch',
      }),
    );
  }
  return queryStoredServedRevisionData({
    dbPath: input.dbPath,
    kind: parsed.kind,
    ...(input.now === undefined ? {} : { now: input.now }),
    request: parsed.request,
    revision: input.revision,
    ...(input.trace === undefined ? {} : { trace: input.trace }),
  }).pipe(
    Effect.flatMap((result) => {
      const resultBytes = Buffer.byteLength(JSON.stringify(result));
      const maximumBytes = maximumResultBytes(parsed.kind);
      return resultBytes <= maximumBytes
        ? Effect.succeed(result)
        : Effect.fail(
            new ServedRevisionQueryError({
              message: `Served revision query result exceeds ${maximumBytes} bytes`,
              reason: 'result-too-large',
            }),
          );
    }),
  );
};
