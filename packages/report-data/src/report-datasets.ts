import type { CursorCommitAttributionRow, ReportDatasets } from '@ai-usage/report-core/datasets';
import { mergeProviderStatusDatasets, parseProviderStatusDataset } from '@ai-usage/report-core/provider-status';

export interface LegacyHarnessFacets extends Record<string, unknown> {
  readonly cursor?: {
    readonly commitAttribution: readonly CursorCommitAttributionRow[];
  };
}

export const mergeReportDatasets = (
  ...datasets: readonly (ReportDatasets | undefined)[]
): ReportDatasets | undefined => {
  const merged: ReportDatasets = {};
  for (const dataset of datasets) {
    if (!dataset) {
      continue;
    }
    for (const [key, value] of Object.entries(dataset)) {
      if (key !== 'providerStatus') {
        merged[key] = value;
      }
    }
  }
  const providerStatus = mergeProviderStatusDatasets(
    datasets.map((dataset) => parseProviderStatusDataset(dataset?.providerStatus) ?? undefined),
  );
  if (providerStatus) {
    merged.providerStatus = providerStatus;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export const mirrorDatasetsToLegacyFacets = (datasets: ReportDatasets | undefined): LegacyHarnessFacets | undefined => {
  if (!datasets?.cursorCommitAttribution?.length) {
    return;
  }
  return { cursor: { commitAttribution: datasets.cursorCommitAttribution } };
};
