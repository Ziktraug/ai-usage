import { buildConstellation } from './constellation-projection';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedReportSupport,
  focusedBreakdownFingerprint,
  matchesFocusedReportQuery,
  parseFocusedBreakdownRequest,
  projectFocusedBreakdown,
} from './focused-report-query';
import type { SerializedRow } from './report-data';
import { enrichSessionPresentationRow } from './session-query';
import { buildTokenFlow } from './token-flow-projection';
import { usageRowModelContributions } from './usage-row';

/** Kept outside the ordinary report projection so graph algorithms load with Observatory. */
export const projectObservatoryBreakdown = (
  rows: SerializedRow[],
  support: FocusedReportSupport,
  input: FocusedBreakdownRequest,
): FocusedBreakdownResult => {
  const request = parseFocusedBreakdownRequest(input);
  if (!request.includeObservatory) {
    throw new Error('Observatory projection requires includeObservatory');
  }
  const visible = rows
    .map(enrichSessionPresentationRow)
    .filter((row) => matchesFocusedReportQuery(row, request.query, support.timeZone));
  return {
    ...projectFocusedBreakdown(rows, support, { query: request.query }),
    requestFingerprint: focusedBreakdownFingerprint(request),
    constellation: buildConstellation(visible, visible.length),
    tokenFlow: buildTokenFlow(
      visible.flatMap((row) =>
        usageRowModelContributions(row).map((segment) => ({
          projectKey: row.projectKey,
          projectLabel: row.projectLabel,
          model: segment.key,
          input: segment.tokIn,
          cacheRead: segment.tokCr,
          cacheWrite: segment.tokCw,
          output: segment.tokOut,
        })),
      ),
      visible.length,
      visible.filter((row) => row.partial || row.usageUnavailable).length,
    ),
  };
};
