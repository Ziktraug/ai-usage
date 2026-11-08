import type { ProviderStatusDataset } from './provider-status';

export interface ReportDatasets extends Record<string, unknown> {
  providerStatus?: ProviderStatusDataset;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseReportDatasets = (value: unknown): ReportDatasets | undefined => {
  if (!isRecord(value)) {
    return;
  }
  // Retired attribution is intentionally ignored in older snapshots and served revisions.
  const { cursorCommitAttribution: _retired, ...datasets } = value;
  return datasets;
};

export const withoutRetiredCursorFacet = (
  facets: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!(facets && isRecord(facets.cursor) && Object.hasOwn(facets.cursor, 'commitAttribution'))) {
    return facets;
  }
  // Legacy portable artifacts may still carry the retired facet.
  const { commitAttribution: _retired, ...cursor } = facets.cursor;
  if (Object.keys(cursor).length) {
    return { ...facets, cursor };
  }
  const { cursor: _cursor, ...remaining } = facets;
  return Object.keys(remaining).length ? remaining : undefined;
};
