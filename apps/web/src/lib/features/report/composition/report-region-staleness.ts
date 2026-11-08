import { focusedBreakdownFingerprint, focusedOverviewFingerprint } from '@ai-usage/report-core/focused-report-query';
import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { type FocusedReportDestination, overviewRequestFor } from './report-destination';

export interface ReportRegionStaleness {
  readonly overview: boolean;
  readonly panel: boolean;
}

const panelIdentity = (destination: FocusedReportDestination): string => {
  const revision = 'visible-request';
  if (destination.kind === 'sessions') {
    return sessionQueryFingerprint({ ...destination.sessions, revision, cursor: null });
  }
  return destination.kind === 'breakdown'
    ? focusedBreakdownFingerprint({ query: { ...destination.query, revision } })
    : 'no-panel';
};

/** Compare requests, not publication revisions: unchanged regions revalidate in place. */
export const reportRegionStaleness = (
  settled: FocusedReportDestination | undefined,
  requested: FocusedReportDestination | null,
): ReportRegionStaleness => {
  if (!requested) {
    return { overview: false, panel: false };
  }
  return {
    overview:
      !settled ||
      focusedOverviewFingerprint(overviewRequestFor(settled, 'visible-request')) !==
        focusedOverviewFingerprint(overviewRequestFor(requested, 'visible-request')),
    panel: !settled || panelIdentity(settled) !== panelIdentity(requested),
  };
};

export const reportVisibleRequestPending = (
  hasCommit: boolean,
  fetching: boolean,
  failed: boolean,
  regions: ReportRegionStaleness,
): boolean => !(hasCommit || failed) || (fetching && (regions.overview || regions.panel));
