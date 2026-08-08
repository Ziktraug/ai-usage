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
import type { ReportQueryClient } from '../../../query/options/report';
import type { SessionQueryScope } from '../../../query/options/session-window';

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
      readonly sessions: SessionQueryScope;
      readonly timeline: FocusedOverviewRequest['timeline'];
    };

export interface FocusedReportDescriptor {
  readonly bootstrap: Extract<ReportRevisionBootstrapResult, { readonly ok: true }>['bootstrap'];
  readonly captureFingerprint: string;
  readonly revision: string;
}

export interface FocusedReportCommit {
  readonly breakdown?: FocusedBreakdownResult;
  readonly descriptor: FocusedReportDescriptor;
  readonly destination: FocusedReportDestination;
  readonly overview: FocusedOverviewResult;
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

export const destinationFingerprint = (destination: FocusedReportDestination): string => {
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

const resultError = (result: { readonly error: { readonly message: string; readonly tag: string } }): Error =>
  result.error.tag === 'RevisionExpired' ? new FocusedReportRevisionExpiredError() : new Error(result.error.message);

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
