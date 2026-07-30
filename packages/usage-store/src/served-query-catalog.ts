import {
  type FocusedBreakdownRequest,
  type FocusedOverviewRequest,
  type FocusedReportQueryKind,
  type FocusedReportQueryResult,
  type FocusedRevisionRequest,
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
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { executeFocusedReportQuery } from './focused-report-query-sqlite';
import {
  assertSessionQueryCursorScope,
  assertSessionQueryDatabase,
  executeMaterializedSessionQuery,
  type SessionQueryKind,
  type SessionQuerySqliteDatabase,
} from './session-query-sqlite';

export type ServedRevisionQueryKind = FocusedReportQueryKind | SessionQueryKind;
export type ServedRevisionQueryResult =
  | FocusedReportQueryResult
  | SessionCampaignChildrenResult
  | SessionDetailAnchorResult
  | SessionNeighborResult
  | SessionPageResult;

export type ParsedServedRevisionQuery =
  | { readonly kind: 'breakdown'; readonly request: FocusedBreakdownRequest; readonly revision: string }
  | { readonly kind: 'campaign-children'; readonly request: SessionCampaignChildrenRequest; readonly revision: string }
  | { readonly kind: 'neighbors'; readonly request: SessionNeighborRequest; readonly revision: string }
  | { readonly kind: 'overview'; readonly request: FocusedOverviewRequest; readonly revision: string }
  | { readonly kind: 'session-detail-anchor'; readonly request: SessionDetailRequest; readonly revision: string }
  | { readonly kind: 'sessions'; readonly request: SessionQueryRequest; readonly revision: string }
  | { readonly kind: 'support'; readonly request: FocusedRevisionRequest; readonly revision: string };

export const parseServedRevisionQuery = (kind: ServedRevisionQueryKind, value: unknown): ParsedServedRevisionQuery => {
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

export const executeServedRevisionQuery = (
  database: SessionQuerySqliteDatabase,
  parsed: ParsedServedRevisionQuery,
): ServedRevisionQueryResult => {
  assertSessionQueryDatabase(database);
  if (parsed.kind === 'sessions') {
    return parseSessionPageResult(
      executeMaterializedSessionQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  if (parsed.kind === 'campaign-children') {
    return parseSessionCampaignChildrenResult(
      executeMaterializedSessionQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  if (parsed.kind === 'neighbors') {
    return parseSessionNeighborResult(
      executeMaterializedSessionQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  if (parsed.kind === 'session-detail-anchor') {
    return parseSessionDetailAnchorResult(
      executeMaterializedSessionQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  if (parsed.kind === 'overview') {
    return parseFocusedReportQueryResult(
      parsed.kind,
      executeFocusedReportQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  if (parsed.kind === 'breakdown') {
    return parseFocusedReportQueryResult(
      parsed.kind,
      executeFocusedReportQuery(database, parsed.kind, parsed.request),
      parsed.request,
    );
  }
  return parseFocusedReportQueryResult(
    parsed.kind,
    executeFocusedReportQuery(database, parsed.kind, parsed.request),
    parsed.request,
  );
};

const catalogSessionRequest = (revision: string): SessionQueryRequest => ({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 1,
  range: { from: null, to: null },
  revision,
  sort: [{ desc: true, id: 'date' }],
});

export const validateServedRevisionQueryCatalog = (database: SessionQuerySqliteDatabase, revision: string): void => {
  const query = catalogSessionRequest(revision);
  const requests: readonly ParsedServedRevisionQuery[] = [
    { kind: 'sessions', request: query, revision },
    { kind: 'campaign-children', request: { campaignKey: 'catalog-missing', query }, revision },
    { kind: 'neighbors', request: { query, rowId: 'catalog-missing' }, revision },
    { kind: 'session-detail-anchor', request: { revision, rowId: 'catalog-missing' }, revision },
    {
      kind: 'overview',
      request: {
        includeAdvanced: true,
        query: { filters: query.filters, range: query.range, revision },
        timeline: { dimension: 'model', granularity: 'day' },
      },
      revision,
    },
    {
      kind: 'breakdown',
      request: { query: { filters: query.filters, range: query.range, revision } },
      revision,
    },
    { kind: 'support', request: { revision }, revision },
  ];
  for (const request of requests) {
    executeServedRevisionQuery(database, request);
  }
};
